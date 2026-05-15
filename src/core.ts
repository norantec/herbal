import 'reflect-metadata';
import { Logger, NotFoundException, Req } from '@nestjs/common';
import { HeaderUtil } from '@open-norantec/utilities/dist/header-util.class';
import { Request, RequestContext } from './types/request.type';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { AttemptUtil, z, ZodError } from '@open-norantec/utilities';
import 'reflect-metadata';
import {
  Controller as NestController,
  UseInterceptors,
  UseGuards,
  mixin,
  BadRequestException,
  Post,
} from '@nestjs/common';
import * as _ from 'lodash';
import { UUIDUtil } from '@open-norantec/utilities/dist/uuid-util.class';
import { CallHandler, CanActivate, Injectable, NestInterceptor, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Request as ExpressRequest, Response } from 'express';
import { HEADERS } from './constants/headers.constant';
import { ModuleRef } from '@nestjs/core';
import { Constructor } from 'type-fest';
import { AuthAdapters } from './decorators/auth-adapter.decorator';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { LoggerService } from './modules/logger/logger.service';
import { Sequelize } from 'sequelize-typescript';
import { Transaction } from 'sequelize';
import { NoTransaction } from './decorators';
import { AuthAdapter } from './abstracts/auth-adapter.abstract.class';
import { PathsObject, SchemaObject } from 'openapi3-ts/oas31';
import { GetModuleFn } from './types';

export * from '@nestjs/core';

const HANDLE_REQUEST_INSTANCE_SYMBOL = '$handleRequestInstance';

export type MethodHandler<IS extends z.ZodType<any>, OS extends z.ZodType<any>> = (
  request: Request,
  input: unknown,
  headers: ReturnType<typeof HeaderUtil.parse>,
) => Promise<{ request: z.infer<IS>; response: z.infer<OS> }>;

/* eslint-disable @typescript-eslint/no-unsafe-function-type */

/**
 * METHOD ZONE
 */
const METHOD_POOL = Symbol();

type ClientGroups = Array<string> | null | undefined;
type ClienttGroupsFactory = (defaultGroupName: string) => ClientGroups;

export interface MethodRegisterOptions<IS extends z.ZodType<any>, OS extends z.ZodType<any>> {
  inputSchema: IS;
  outputSchema: OS;
  authAdapters?: Constructor<AuthAdapter>[];
  clientGroups?: ClientGroups | ClienttGroupsFactory;
  disableTransaction?: boolean;
}

export type MethodRegisterFn<C> = <IS extends z.ZodType<any>, OS extends z.ZodType<any>>(
  name: string,
  options: MethodRegisterOptions<IS, OS>,
  callback: MethodCallback<IS, OS, C>,
) => void;

export interface MethodContext<IS extends z.ZodType<any>> extends RequestContext {
  headers: ReturnType<typeof HeaderUtil.parse>;
  input: z.infer<IS>;
  url: string;
}

export type MethodCallContext<IS extends z.ZodType<any>> = Omit<MethodContext<IS>, 'input'>;

export type MethodCallback<IS extends z.ZodType<any>, OS extends z.ZodType<any>, C> = (
  this: C,
  context: MethodContext<IS>,
) => Promise<z.infer<OS>>;

class MethodConfig<IS extends z.ZodType<any>, OS extends z.ZodType<any>, C> {
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

  public registerMethod<IS extends z.ZodType<any>, OS extends z.ZodType<any>, C>(
    name: string,
    options: MethodRegisterOptions<IS, OS>,
    callback: MethodCallback<IS, OS, C>,
  ) {
    if (StringUtil.isFalsyString(name)) return;
    if (name!.includes('/')) throw new Error(`Method name cannot contain slashes: ${name}`);
    this.methods.set(name!, new MethodConfig(name, options, callback));
  }

  public transactionDisabled(name?: string) {
    if (StringUtil.isFalsyString(name)) return false;
    if (name!.includes('/')) throw new Error(`Method name cannot contain slashes: ${name}`);
    return !!this.methods.get(name!)?.options?.disableTransaction;
  }

  public getCallFn(name: string) {
    const config = this.methods.get(name);
    if (!(config instanceof MethodConfig)) return null;
    return config.call.bind(config) as typeof config.call;
  }

  public getAuthAdapters(name?: string) {
    if (StringUtil.isFalsyString(name)) return null;
    const config = this.methods.get(name!);
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
                schema: (config.options.inputSchema as z.ZodType<any>).toJSONSchema() as SchemaObject,
              },
            },
          },
          responses: {
            '200': {
              description: 'Response for method ' + name,
              content: {
                'application/json': {
                  schema: z
                    .object({
                      data: config.options.outputSchema as z.ZodType<any>,
                      token: z.string().nullable(),
                    })
                    .toJSONSchema(),
                },
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
const AFTER_PARSING_REQUEST_HANDLERS = Symbol();
const BEFORE_PARSING_REQUEST_HANDLERS = Symbol();

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
  ignoreControllerNamePostfix?: boolean;
  prefix?: string;
  methods?: (register: MethodRegisterFn<C>) => void;
  onAfterParsingRequest?: (request: Request, getModule: GetModuleFn) => void | Promise<void>;
  onBeforeParsingRequest?: (request: Request, getModule: GetModuleFn) => void | Promise<void>;
}

export interface ControllerUtilCreateOptions {
  prefix?: string;
  getTraceId?: (request: ExpressRequest) => string;
  onAfterParsingRequest?: HerbalControllerOptions<any>['onAfterParsingRequest'];
  onBeforeParsingRequest?: HerbalControllerOptions<any>['onBeforeParsingRequest'];
}

export async function parseRequest({
  request,
  traceId: inputTraceId,
  sequelize: sequelizeInstance,
  handlerName,
  handlerPrototype,
  onLog,
  getModule,
}: {
  handlerPrototype: object;
  request: Request;
  handlerName?: string;
  sequelize?: Sequelize;
  traceId?: string;
  getModule: GetModuleFn;
  onLog?: (methodName: string, message: string) => void;
}): Promise<void> {
  let transaction: Transaction | undefined = undefined;
  const beforeParsingRequestHandlers: Array<NonNullable<HerbalControllerOptions<any>['onBeforeParsingRequest']>> =
    Reflect.getMetadata(BEFORE_PARSING_REQUEST_HANDLERS, handlerPrototype);
  const afterParsingRequestHandlers: Array<NonNullable<HerbalControllerOptions<any>['onAfterParsingRequest']>> =
    Reflect.getMetadata(AFTER_PARSING_REQUEST_HANDLERS, handlerPrototype);

  request.traceId = StringUtil.isFalsyString(inputTraceId) ? UUIDUtil.generateV4() : inputTraceId!;
  request.methodName = request.url.split('/').pop()!;

  if (typeof request.rawBody === 'undefined') {
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
  }

  _.attempt(() => onLog?.('log', `[trace:${request?.traceId}:request:body] ${request.rawBody}`));

  await Promise.all(
    (Array.isArray(beforeParsingRequestHandlers) ? beforeParsingRequestHandlers : []).map((handler) =>
      handler(request, getModule),
    ),
  );

  const methodPool = getMethodPool(handlerPrototype);
  let authAdapters = methodPool?.getAuthAdapters?.(request.methodName);

  if (authAdapters === null) authAdapters = AuthAdapters.getAdapters(handlerPrototype, handlerName);

  const shouldHaveTransaction =
    !NoTransaction.isDisabled(handlerPrototype, handlerName) && !methodPool?.transactionDisabled?.(request.methodName);

  if (sequelizeInstance instanceof Sequelize && shouldHaveTransaction) {
    try {
      transaction = await sequelizeInstance?.transaction?.()?.catch(() => Promise.resolve(undefined));
      request.transaction = transaction;
      onLog?.('log', `[trace:${request?.traceId}:transaction] Started transaction for route: ${request.url}`);
    } catch (error) {
      if (error instanceof Error) {
        onLog?.(
          'error',
          `[trace:${request?.traceId}:transaction] Failed to start transaction: ${error?.message}\n${error?.stack}`,
        );
      }
    }
  } else if (!shouldHaveTransaction) {
    onLog?.('log', `[trace:${request?.traceId}:transaction] Transaction is disabled for this route: ${request.url}`);
  } else {
    throw new Error('Sequelize instance not found, cannot start transaction');
  }

  try {
    if (Array.isArray(authAdapters) && authAdapters.length > 0 && typeof request.authenticateResult === 'undefined') {
      const authSucceeded = await (async () => {
        for (const AuthAdapterClass of authAdapters) {
          const adapter = new AuthAdapterClass(request, getModule);
          if (!adapter.match()) continue;
          const authenticateResult = await adapter.authenticate(transaction);
          if (!authenticateResult) break;
          request.authenticateResult = {
            AuthenticatorClass: AuthAdapterClass,
            ...authenticateResult,
          };
          return true;
        }
        return false;
      })();
      if (!authSucceeded) throw new UnauthorizedException();
    }
  } catch (error) {
    try {
      if (error instanceof Error) {
        onLog?.(
          'error',
          `[trace:${request?.traceId}:error] Got error when handling route: ${error?.message} ${error?.stack}`,
        );
      }
      await transaction?.rollback?.();
    } catch {}
    throw error;
  } finally {
    await Promise.all(
      (Array.isArray(afterParsingRequestHandlers) ? afterParsingRequestHandlers : []).map((handler) =>
        handler(request, getModule),
      ),
    );
  }
}

function HerbalGuard(options: Pick<ControllerUtilCreateOptions, 'getTraceId'>) {
  @Injectable()
  class HerbalGuardMixin implements CanActivate {
    public constructor(protected readonly ref: ModuleRef) {}

    public async canActivate(context: ExecutionContext): Promise<boolean> {
      const logger = this.getLogger();
      const sequelizeInstance = _.attempt(() => this.ref.get(Sequelize, { strict: false }));
      const request: Request = context.switchToHttp().getRequest();
      const response: Response = context.switchToHttp().getResponse();
      let traceId =
        typeof options?.getTraceId === 'function'
          ? _.attempt(() => options!.getTraceId!(request))
          : UUIDUtil.generateV4();

      if (traceId instanceof Error || StringUtil.isFalsyString(traceId)) traceId = UUIDUtil.generateV4();

      await parseRequest({
        request,
        sequelize: sequelizeInstance instanceof Error ? undefined : sequelizeInstance,
        handlerPrototype: context?.getClass?.()?.prototype ?? {},
        handlerName: context?.getHandler?.()?.name,
        traceId,
        getModule: this.ref.get.bind(this.ref) as GetModuleFn,
        onLog: (method, message) => {
          try {
            logger[method]?.(message);
          } catch {}
        },
      });

      response.setHeader(HEADERS.TRACE_ID, traceId);

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

export function getMethodPool(targetPrototype: object) {
  const methodPool = Reflect.getMetadata(METHOD_POOL, targetPrototype) as MethodPool;
  if (!(methodPool instanceof MethodPool)) return null;
  return methodPool;
}

export class ControllerUtil {
  public static create(createOptions?: ControllerUtilCreateOptions) {
    const logger = new Logger('Herbal');

    function Controller<C>(options?: HerbalControllerOptions<C>): ClassDecorator {
      return (target) => {
        const methodPool = new MethodPool();
        let finalPrefix: string = StringUtil.isFalsyString(options?.prefix)
          ? StringUtil.isFalsyString(createOptions?.prefix)
            ? ''
            : createOptions!.prefix!
          : options!.prefix!;
        const controllerName = _.camelCase(target.name.replace(/Controller$/g, ''));
        const paths: string[] = [];

        if (!options?.ignoreControllerNamePostfix) {
          finalPrefix += `${finalPrefix?.endsWith?.('/') ? '' : '/'}${controllerName}`;
        }

        const register: MethodRegisterFn<C> = (name, options, callback) => {
          if (StringUtil.isFalsyString(name) || typeof callback !== 'function') return;
          methodPool.registerMethod(name, options, callback);
          paths.push(name.startsWith('/') ? name : `/${name}`);
        };

        if (!finalPrefix.startsWith('/')) finalPrefix = `/${finalPrefix}`;

        Reflect.defineMetadata(IS_HERBAL_CONTROLLER, true, target.prototype);
        Reflect.defineMetadata(CONTROLLER_NAME, controllerName, target.prototype);
        Reflect.defineMetadata(METHOD_POOL, methodPool, target.prototype);

        if (typeof options?.methods === 'function') options.methods(register);

        async function handleRequest(request: Request) {
          const callFn = getMethodPool(this)?.getCallFn?.(request.methodName!);
          if (typeof callFn !== 'function') throw new NotFoundException(`Method ${request.methodName!} not found`);
          try {
            const result = {
              data: await callFn(this, {
                authenticateResult: request.authenticateResult,
                headers: HeaderUtil.parse(request.headers ?? {}),
                methodName: request.methodName,
                rawBody: request.rawBody,
                traceId: request.traceId,
                transaction: request.transaction,
                url: request.originalUrl,
              }),
              token: StringUtil.isFalsyString(request?.authenticateResult?.nextToken)
                ? null
                : request.authenticateResult!.nextToken!,
            };
            await request?.transaction?.commit?.();
            return result;
          } catch (error) {
            await AttemptUtil.execPromise(
              (async () => {
                await request?.transaction?.rollback?.();
              })(),
            );
            throw error;
          }
        }

        Object.defineProperty(target.prototype, HANDLE_REQUEST_INSTANCE_SYMBOL, {
          enumerable: false,
          writable: false,
          value: function $herbalInternal(request: Request) {
            return handleRequest.call(this, request);
          },
        });

        Req()(target.prototype, HANDLE_REQUEST_INSTANCE_SYMBOL, 0);

        if (paths.length > 0) {
          Post(paths)(
            target.prototype,
            HANDLE_REQUEST_INSTANCE_SYMBOL,
            Object.getOwnPropertyDescriptor(target.prototype, HANDLE_REQUEST_INSTANCE_SYMBOL)!,
          );

          paths.forEach((path) => {
            logger.log(`Mapped method: /${controllerName}${path}`);
          });
        }

        const beforeParsingRequestHandlers: HerbalControllerOptions<any>['onBeforeParsingRequest'][] = [];
        const afterParsingRequestHandlers: HerbalControllerOptions<any>['onAfterParsingRequest'][] = [];

        if (typeof createOptions?.onBeforeParsingRequest === 'function')
          beforeParsingRequestHandlers.push(createOptions.onBeforeParsingRequest);
        if (typeof options?.onBeforeParsingRequest === 'function')
          beforeParsingRequestHandlers.push(options.onBeforeParsingRequest);
        if (typeof options?.onAfterParsingRequest === 'function')
          afterParsingRequestHandlers.push(options.onAfterParsingRequest);
        if (typeof createOptions?.onAfterParsingRequest === 'function')
          afterParsingRequestHandlers.push(createOptions.onAfterParsingRequest);

        Reflect.defineMetadata(BEFORE_PARSING_REQUEST_HANDLERS, beforeParsingRequestHandlers, target.prototype);
        Reflect.defineMetadata(AFTER_PARSING_REQUEST_HANDLERS, afterParsingRequestHandlers, target.prototype);

        NestController(finalPrefix)(target);
        UseInterceptors(ControllerInterceptor)(target);
        UseGuards(HerbalGuard(_.pick(createOptions, ['getTraceId'])))(target);
      };
    }

    Controller.isHerbalController = isHerbalController;
    Controller.getControllerName = getControllerName;

    return Controller;
  }
}

export function getRequestHandler(controller: object) {
  try {
    const requestHandler = Object.getOwnPropertyDescriptor(controller, HANDLE_REQUEST_INSTANCE_SYMBOL)?.value;
    if (typeof requestHandler !== 'function') return null;
    return requestHandler as (request: Request) => Promise<any>;
  } catch {
    return null;
  }
}
