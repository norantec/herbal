/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import 'reflect-metadata';
import { Controller as NestController, UseInterceptors, UseGuards } from '@nestjs/common';
import * as _ from 'lodash';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { CallHandler, CanActivate, Injectable, NestInterceptor, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Request } from '../types/request.type';
import { v4 as uuidv4 } from 'uuid';
import { Response } from 'express';
import { HEADERS } from '../constants/headers.constant';
import { ModuleRef } from '@nestjs/core';
import { Constructor } from 'type-fest';
import { AuthAdapters } from '../decorators/auth-adapter.decorator';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { LoggerService } from '../modules/logger/logger.service';
import { Sequelize } from 'sequelize-typescript';

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
            _.attempt(() =>
                this.getLogger().log(`[trace:${request?.traceId}:request:body] ${JSON.stringify(request?.body)}`),
            );
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
                _.attempt(() => request?.transaction?.rollback?.()?.catch?.(() => {}));
                return throwError(() => error);
            }),
        );
    }
}

@Injectable()
class HerbalGuard implements CanActivate {
    public constructor(protected readonly ref: ModuleRef) {}

    public async canActivate(context: ExecutionContext): Promise<boolean> {
        const traceId = uuidv4();
        const transaction = await this.ref
            ?.get?.(Sequelize, { strict: false })
            ?.transaction?.()
            ?.catch(() => Promise.resolve(undefined));
        const request: Request = context.switchToHttp().getRequest();
        const response: Response = context.switchToHttp().getResponse();

        request.traceId = traceId;
        request.methodName = request.url.split('/').pop()!;
        request.transaction = transaction;
        response.setHeader(HEADERS.TRACE_ID, traceId);

        const authAdapters = AuthAdapters.getAdapters(context?.getClass?.()?.prototype, request.methodName);

        try {
            if (Array.isArray(authAdapters) && authAdapters.length > 0) {
                for (const AuthAdapterClass of authAdapters) {
                    const adapter = new AuthAdapterClass(request, this.ref);
                    if (!adapter.match()) continue;
                    const authenticateResult = await adapter.authenticate();
                    if (!authenticateResult) return false;
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
                await transaction?.rollback?.();
            } catch {}
            throw error;
        }

        return true;
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
                finalPrefix += `/${_.camelCase(target.name.replace(/Controller$/g, ''))}`;
                if (!finalPrefix.startsWith('/')) finalPrefix = `/${finalPrefix}`;
                Reflect.defineMetadata(IS_CONTROLLER, true, target.prototype);
                NestController(finalPrefix)(target);
                UseInterceptors(ControllerInterceptor)(target);
                UseGuards(
                    HerbalGuard,
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
