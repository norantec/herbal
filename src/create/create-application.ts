import 'reflect-metadata';
import { CorsOptions, CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import { Constructor, PartialDeep } from 'type-fest';
import {
  CanActivate,
  ExceptionFilter,
  INestApplication,
  NestApplicationOptions,
  NestInterceptor,
  PipeTransform,
  WebSocketAdapter,
} from '@nestjs/common';
import { OpenAPIObject } from 'openapi3-ts/oas31';
export type Resolver = <T>(Class: Constructor<T>) => Promise<T>;

export interface CreateApplicationOptions {
  Module: Constructor<any>;
  cors?: CorsOptions | CorsOptionsDelegate<any> | false;
  factoryOptions?: NestApplicationOptions;
  globalFilters?: ExceptionFilter[];
  globalGuards?: CanActivate[];
  globalInterceptors?: NestInterceptor[];
  globalPipes?: PipeTransform<any>[];
  openAPIGroups?: string[];
  openAPIObject?: PartialDeep<Omit<OpenAPIObject, 'paths'>>;
  openAPIPath?: string;
  openAPIPrefix?: string;
  uses?: any[];
  websocketAdapter?: WebSocketAdapter;
  getListenPort: (resolver: Resolver) => number | Promise<number>;
  callback?: (listenPort: number, app: INestApplication<any>) => void | Promise<void>;
  onBeforeBootstrap?: () => void | Promise<void>;
  worker?: (resolver: Resolver, listenPort: number) => any;
}

class Application {
  public constructor(public readonly options: CreateApplicationOptions) {}
}

export function isApplication(input: any) {
  return input instanceof Application;
}

export function createApplication(options: CreateApplicationOptions) {
  return new Application(options);
}
