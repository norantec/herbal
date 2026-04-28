/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import 'reflect-metadata';
import { Controller as NestController, UseInterceptors, UseGuards, mixin, BadRequestException } from '@nestjs/common';
import * as _ from 'lodash';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { UUIDUtil } from '@open-norantec/utilities/dist/uuid-util.class';
import { CallHandler, CanActivate, Injectable, NestInterceptor, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Request, RequestContext } from '../types/request.type';
import { Request as ExpressRequest, Response } from 'express';
import { HEADERS } from '../constants/headers.constant';
import { ModuleRef } from '@nestjs/core';
import { Constructor } from 'type-fest';
import { AuthAdapters } from '../decorators/auth-adapter.decorator';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { LoggerService } from '../modules/logger/logger.service';
import { Sequelize } from 'sequelize-typescript';
import { Transaction } from 'sequelize';
import { NoTransaction } from '../decorators';
import { ZodError, z } from 'zod';
import { AuthAdapter } from '../abstracts/auth-adapter.abstract.class';
import { HeaderUtil } from '@open-norantec/utilities/dist/header-util.class';
import { PathsObject, SchemaObject } from 'zod-openapi/dist/openapi3-ts/dist/model/openapi31';
import { createSchema } from 'zod-openapi';

/**
 * METHOD ZONE
 */

const METHOD_POOL = Symbol();

type ClientGroups = Array<string> | null | undefined;
type ClienttGroupsFactory = (defaultGroupName: string) => ClientGroups;

export interface MethodRegisterOptions<IS extends z.Schema<any>, OS extends z.Schema<any>> {
  inputSchema: IS;
  outputSchema: OS;
  authAdapters?: Constructor<AuthAdapter>[];
  clientGroups?: ClientGroups | ClienttGroupsFactory;
  disableTransaction?: boolean;
}

export type MethodRegisterFn<C> = <IS extends z.Schema<any>, OS extends z.Schema<any>>(
  name: string,
  options: MethodRegisterOptions<IS, OS>,
  callback: MethodCallback<IS, OS, C>,
) => void;

export interface MethodContext<IS extends z.Schema<any>> extends RequestContext {
  headers: ReturnType<typeof HeaderUtil.parse>;
  input: z.infer<IS>;
  url: string;
}

export type MethodCallContext<IS extends z.Schema<any>> = Omit<MethodContext<IS>, 'input'>;

export type MethodCallback<IS extends z.Schema<any>, OS extends z.Schema<any>, C> = (
  this: C,
  context: MethodContext<IS>,
) => Promise<z.infer<OS>>;

class MethodConfig<IS extends z.Schema<any>, OS extends z.Schema<any>, C> {
  public constructor(
    public readonly name: string,
    public readonly options: MethodRegisterOptions<IS, OS>,
    protected readonly callback: MethodCallback<IS, OS, C>,
  ) {}

  public async call(controller: C, callContext: MethodCallContext<IS>) {
    const inputSchema = this.options.inputSchema;
    const outputSchema = this.options.outputSchema;

    try {
      const parsedBody = _.attempt(() => JSON.parse(callContext?.rawBody || '') as Record<string, unknown>);
      const input = _.attempt(() => (parsedBody instanceof Error ? undefined : inputSchema.parse(parsedBody)));

      if (input instanceof ZodError) {
        throw new BadRequestException({
          from: 'request',
          invalidParams: input?.issues?.map?.((item) => item?.path?.join?.('.')) ?? [],
        });
      } else if (input instanceof Error) throw input;

      const rawResponse = await this.callback.call(controller, { ...callContext, input });

      const response = _.attempt(() => outputSchema.parse(rawResponse));

      if (response instanceof ZodError) {
        throw new BadRequestException({
          from: 'response',
          invalidParams: response?.issues?.map?.((item) => item?.path?.join?.('.')) ?? [],
        });
      } else if (response instanceof Error) throw response;

      return response as z.infer<OS>;
    } catch (error) {
      throw error;
    }
  }
}

class MethodPool {
  protected readonly methods = new Map<string, MethodConfig<any, any, any>>();

  public registerMethod<IS extends z.Schema<any>, OS extends z.Schema<any>, C>(
    name: string,
    options: MethodRegisterOptions<IS, OS>,
    callback: MethodCallback<IS, OS, C>,
  ) {
    if (StringUtil.isFalsyString(name)) return;
    if (name!.includes('/')) throw new Error(`Method name cannot contain slashes: ${name}`);
    this.methods.set(name!, new MethodConfig(name, options, callback));
  }

  public getCallFn(name: string) {
    const config = this.methods.get(name);
    if (!(config instanceof MethodConfig)) return null;
    return config.call.bind(config) as typeof config.call;
  }

  public getAuthAdapters(name: string) {
    const config = this.methods.get(name);
    if (!(config instanceof MethodConfig)) return null;
    return config.options.authAdapters;
  }

  public getOpenAPIPathsObject(group?: string) {
    const result: PathsObject = {};
    Array.from(this.methods.entries()).forEach(([name, config]) => {
      const defaultGroupName = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const currentGroupName = StringUtil.isFalsyString(group) ? defaultGroupName : group!;
      const clientGroups =
        typeof config.options.clientGroups === 'function'
          ? config.options.clientGroups(defaultGroupName)
          : config?.options?.clientGroups;

      if (!Array.isArray(clientGroups) && !StringUtil.isFalsyString(group) && defaultGroupName !== group) return;
      if (Array.isArray(clientGroups) && !clientGroups.includes(currentGroupName)) return;

      result[`/${name}`] = {
        post: {
          requestBody: {
            description: 'Request body for method ' + name,
            required: true,
            content: {
              'application/json': {
                schema: createSchema(config.options.inputSchema).schema as SchemaObject,
              },
            },
          },
          responses: {
            '200': {
              description: 'Response for method ' + name,
              content: {
                'application/json': createSchema(
                  z.object({
                    data: config.options.outputSchema,
                    token: z.string().nullable(),
                  }),
                ),
              },
            },
          },
        },
      };
    });
    return result;
  }
}

/**
 * CONTROLLER UTIL ZONE
 */

const IS_HERBAL_CONTROLLER = Symbol();
const CONTROLLER_NAME = Symbol();

export function isHerbalController(target: Function) {
  return _.attempt(() => Reflect.getMetadata(IS_HERBAL_CONTROLLER, target.prototype)) === true;
}

export function getControllerName(target: Function) {
  return Reflect.getMetadata(CONTROLLER_NAME, target.prototype);
}

@Injectable()
class ControllerInterceptor implements NestInterceptor {
  public constructor(private readonly ref: ModuleRef) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request: Request = context.switchToHttp().getRequest();
    if (isHerbalController(context.getClass())) {
      _.attempt(() => {
        this.getLogger().log(`[trace:${request?.traceId}:response:url] ${request?.originalUrl}`);
      });
      _.attempt(() =>
        this.getLogger().log(`[trace:${request?.traceId}:request:headers] ${JSON.stringify(request?.headers)}`),
      );
      return this.handle(next, request);
    }
    return next.handle();
  }

  private getLogger() {
    const loggerService = this.ref.get(LoggerService, { strict: false });
    if (!(loggerService instanceof LoggerService)) {
      return {
        log: () => {},
        error: () => {},
      };
    }
    return loggerService;
  }

  private handle(next: CallHandler, request: Request) {
    return next.handle().pipe(
      map((data) => {
        _.attempt(() => {
          this.getLogger().log(`[trace:${request?.traceId}:response:raw] ${JSON.stringify(data)}`);
        });
        _.attempt(() => {
          this.getLogger().log(`[trace:${request?.traceId}:response:final] ${JSON.stringify(data)}`);
        });
        return data;
      }),
      catchError((error: Error) => {
        _.attempt(() => {
          this.getLogger().error(`[trace:${request?.traceId}:response:error:message] ${error?.message}`);
        });
        _.attempt(() => {
          this.getLogger().error(`[trace:${request?.traceId}:response:error:stack] ${error?.stack}`);
        });
        this.getLogger().error(`Got error when handling route in interceptor: ${error?.message} ${error?.stack}`);
        _.attempt(() => request?.transaction?.rollback?.()?.catch?.(() => {}));
        return throwError(() => error);
      }),
    );
  }
}

export interface HerbalControllerOptions<C> {
  prefix?: string;
  useHeadGuards?: Constructor<any>[];
  useTailGuards?: Constructor<any>[];
  methods?: (register: MethodRegisterFn<C>) => void;
}

export interface ControllerUtilCreateOptions {
  prefix?: string;
  useGuards?: Constructor<any>[];
  getTraceId?: (request: ExpressRequest) => string;
}

function HerbalGuard(options: Pick<ControllerUtilCreateOptions, 'getTraceId'>) {
  @Injectable()
  class HerbalGuardMixin implements CanActivate {
    public constructor(protected readonly ref: ModuleRef) {}

    public async canActivate(context: ExecutionContext): Promise<boolean> {
      const sequelizeInstance = _.attempt(() => this.ref.get(Sequelize, { strict: false }));
      let transaction: Transaction | undefined = undefined;
      const request: Request = context.switchToHttp().getRequest();
      const response: Response = context.switchToHttp().getResponse();
      let traceId =
        typeof options?.getTraceId === 'function'
          ? _.attempt(() => options!.getTraceId!(request))
          : UUIDUtil.generateV4();

      if (traceId instanceof Error || StringUtil.isFalsyString(traceId)) traceId = UUIDUtil.generateV4();

      request.traceId = traceId;
      request.methodName = request.url.split('/').pop()!;
      response.setHeader(HEADERS.TRACE_ID, traceId);

      const chunks: Uint8Array[] = [];

      try {
        for await (const chunk of request) chunks.push(chunk);
      } catch {}

      const parsedBody = _.attempt(() => Buffer.concat(chunks).toString('utf8'));

      if (!(parsedBody instanceof Error)) {
        request.rawBody = parsedBody;
      } else {
        request.rawBody = null;
      }

      _.attempt(() => this.getLogger().log(`[trace:${request?.traceId}:request:body] ${request.rawBody}`));

      const rawHandlerName = context?.getHandler?.()?.name;
      const handlerPropertype = context?.getClass?.()?.prototype;
      const handlerName = StringUtil.isFalsyString(rawHandlerName) ? request.methodName : rawHandlerName;
      let authAdapters = ControllerUtil.getPool(handlerPropertype)?.getAuthAdapters?.(handlerName);

      if (authAdapters === null) authAdapters = AuthAdapters.getAdapters(handlerPropertype, handlerName);

      if (!(sequelizeInstance instanceof Error) && !NoTransaction.isDisabled(handlerPropertype, handlerName)) {
        try {
          transaction = await sequelizeInstance?.transaction?.()?.catch(() => Promise.resolve(undefined));
          request.transaction = transaction;
          this.getLogger().log(`[trace:${request?.traceId}:transaction] Started transaction for route: ${handlerName}`);
        } catch (error) {
          if (error instanceof Error) {
            this.getLogger().error(
              `[trace:${request?.traceId}:transaction] Failed to start transaction: ${error?.message}\n${error?.stack}`,
            );
          }
        }
      } else if (NoTransaction.isDisabled(handlerPropertype, handlerName)) {
        this.getLogger().log(
          `[trace:${request?.traceId}:transaction] Transaction is disabled for this route: ${handlerName}`,
        );
      }

      try {
        if (Array.isArray(authAdapters) && authAdapters.length > 0) {
          for (const AuthAdapterClass of authAdapters) {
            const adapter = new AuthAdapterClass(request, this.ref);
            if (!adapter.match()) continue;
            const authenticateResult = await adapter.authenticate(transaction);
            if (!authenticateResult) break;
            request.authenticateResult = {
              AuthenticatorClass: AuthAdapterClass,
              ...authenticateResult,
            };
            return true;
          }
          throw new UnauthorizedException();
        }
      } catch (error) {
        try {
          if (error instanceof Error) {
            this.getLogger().error(`Got error when handling route: ${error?.message} ${error?.stack}`);
          }
          await transaction?.rollback?.();
        } catch {}
        throw error;
      }

      return true;
    }

    private getLogger() {
      const loggerService = this.ref.get(LoggerService, { strict: false });
      if (!(loggerService instanceof LoggerService)) {
        return {
          log: () => {},
          error: () => {},
        };
      }
      return loggerService;
    }
  }

  return mixin(HerbalGuardMixin);
}

export class ControllerUtil {
  public static getPool(targetPrototype: object) {
    const pool = Reflect.getMetadata(METHOD_POOL, targetPrototype) as MethodPool;
    if (!(pool instanceof MethodPool)) return null;
    return pool;
  }

  public static create(createOptions?: ControllerUtilCreateOptions) {
    function Controller<C>(options?: HerbalControllerOptions<C>): ClassDecorator {
      return (target) => {
        const methodPool = new MethodPool();
        let finalPrefix: string = StringUtil.isFalsyString(options?.prefix)
          ? StringUtil.isFalsyString(createOptions?.prefix)
            ? ''
            : createOptions!.prefix!
          : options!.prefix!;
        const controllerName = _.camelCase(target.name.replace(/Controller$/g, ''));
        finalPrefix += `${finalPrefix?.endsWith?.('/') ? '' : '/'}${controllerName}`;
        const register: MethodRegisterFn<C> = (name, options, callback) => {
          if (StringUtil.isFalsyString(name) || typeof callback !== 'function') return;
          methodPool.registerMethod(name, options, callback);
        };

        if (!finalPrefix.startsWith('/')) finalPrefix = `/${finalPrefix}`;

        Reflect.defineMetadata(IS_HERBAL_CONTROLLER, true, target.prototype);
        Reflect.defineMetadata(CONTROLLER_NAME, controllerName, target.prototype);
        Reflect.defineMetadata(METHOD_POOL, methodPool, target.prototype);

        if (typeof options?.methods === 'function') options.methods(register);

        NestController(finalPrefix)(target);
        UseInterceptors(ControllerInterceptor)(target);
        UseGuards(
          HerbalGuard(_.pick(createOptions, ['getTraceId'])),
          ...(Array.isArray(options?.useHeadGuards) ? options!.useHeadGuards : []),
          ...(Array.isArray(createOptions?.useGuards) ? createOptions!.useGuards : []),
          ...(Array.isArray(options?.useTailGuards) ? options!.useTailGuards : []),
        )(target);
      };
    }

    Controller.isHerbalController = isHerbalController;
    Controller.getControllerName = getControllerName;

    return Controller;
  }
}
