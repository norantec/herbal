/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import 'reflect-metadata';
import { Controller as NestController, UseInterceptors, UseGuards, mixin } from '@nestjs/common';
import * as _ from 'lodash';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { UUIDUtil } from '@open-norantec/utilities/dist/uuid-util.class';
import { CallHandler, CanActivate, Injectable, NestInterceptor, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Request } from '../types/request.type';
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

const IS_CONTROLLER = Symbol();

export function isHerbalController(target: Function) {
  return _.attempt(() => Reflect.getMetadata(IS_CONTROLLER, target.prototype)) === true;
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

export interface HerbalControllerOptions {
  prefix?: string;
  useHeadGuards?: Constructor<any>[];
  useTailGuards?: Constructor<any>[];
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
      // request.transaction = transaction;
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
      const authAdapters = AuthAdapters.getAdapters(handlerPropertype, handlerName);

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
  public static create(createOptions?: ControllerUtilCreateOptions) {
    function Controller(options?: HerbalControllerOptions): ClassDecorator {
      return (target) => {
        let finalPrefix: string = StringUtil.isFalsyString(options?.prefix)
          ? StringUtil.isFalsyString(createOptions?.prefix)
            ? ''
            : createOptions!.prefix!
          : options!.prefix!;
        finalPrefix += `${finalPrefix?.endsWith?.('/') ? '' : '/'}${_.camelCase(target.name.replace(/Controller$/g, ''))}`;
        if (!finalPrefix.startsWith('/')) finalPrefix = `/${finalPrefix}`;
        Reflect.defineMetadata(IS_CONTROLLER, true, target.prototype);
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
    return Controller;
  }
}
