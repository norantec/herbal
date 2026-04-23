import 'reflect-metadata';
import { ZodError, z } from 'zod';
import { AuthAdapter } from '../abstracts';
import { GroupsFactory } from './client-groups.decorator';
import { HeaderUtil } from '@open-norantec/utilities/dist/header-util.class';
import { StringUtil } from '@open-norantec/utilities';
import { Constructor } from 'type-fest';
import { BadRequestException, Type } from '@nestjs/common';
import * as _ from 'lodash';
import { RequestContext } from '../types';
import { createSchema } from 'zod-openapi';
import { PathsObject, SchemaObject } from 'zod-openapi/dist/openapi3-ts/dist/model/openapi31';

const METHOD_POOL = Symbol();

export interface MethodOptions<IS extends z.Schema<any>, OS extends z.Schema<any>> {
  inputSchema: IS;
  outputSchema: OS;
  authAdapters?: AuthAdapter[];
  clientGroups?: GroupsFactory | string[];
  disableTransaction?: boolean;
}

export type DependencyGetter = <T>(dependency: Constructor<T>) => T;

export interface MethodContext<IS extends z.Schema<any>> extends Omit<RequestContext, 'moduleRef'> {
  headers: ReturnType<typeof HeaderUtil.parse>;
  input: z.infer<IS>;
  url: string;
  getProvider: <TInput = any, TResult = TInput>(typeOrToken: Type<TInput> | Function | string | symbol) => TResult;
}

export type MethodCallContext<IS extends z.Schema<any>> = Omit<MethodContext<IS>, 'input'>;

export type MethodCallback<IS extends z.Schema<any>, OS extends z.Schema<any>> = (
  context: MethodContext<IS>,
) => Promise<z.infer<OS>>;

class MethodConfig<IS extends z.Schema<any>, OS extends z.Schema<any>> {
  public constructor(
    public readonly name: string,
    public readonly options: MethodOptions<IS, OS>,
    protected readonly callback: MethodCallback<IS, OS>,
  ) {}

  public async call(callContext: MethodCallContext<IS>) {
    try {
      const parsedBody = _.attempt(() => JSON.parse(callContext?.rawBody || '') as Record<string, unknown>);
      const input = _.attempt(() =>
        parsedBody instanceof Error ? undefined : this.options.inputSchema.parse(parsedBody),
      );

      if (input instanceof ZodError) {
        throw new BadRequestException({
          from: 'request',
          invalidParams: input?.issues?.map?.((item) => item?.path?.join?.('.')) ?? [],
        });
      } else if (input instanceof Error) throw input;

      const rawResponse = await this.callback({ ...callContext, input });

      const response = _.attempt(() => this.options.outputSchema.parse(rawResponse));

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
  protected readonly methods = new Map<string, MethodConfig<any, any>>();

  public registerMethod<IS extends z.Schema<any>, OS extends z.Schema<any>>(
    name: string,
    options: MethodOptions<IS, OS>,
    callback: MethodCallback<IS, OS>,
  ) {
    if (StringUtil.isFalsyString(name)) return;
    if (name!.includes('/')) throw new Error(`Method name cannot contain slashes: ${name}`);
    this.methods.set(name!, new MethodConfig(name, options, callback));
  }

  public getCallFn(name: string) {
    const callFn = this.methods.get(name)?.call;
    return typeof callFn === 'function' ? callFn.bind(this) : null;
  }

  public getOpenAPIPathsObject() {
    const result: PathsObject = {};
    Array.from(this.methods.entries()).forEach(([name, config]) => {
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

export function Method<IS extends z.Schema<any>, OS extends z.Schema<any>>(
  ...parameters: Parameters<typeof MethodPool.prototype.registerMethod<IS, OS>>
): ClassDecorator {
  return (target) => {
    let pool = Reflect.getMetadata(METHOD_POOL, target.prototype) as MethodPool;

    if (!(pool instanceof MethodPool)) {
      pool = new MethodPool();
      Reflect.defineMetadata(METHOD_POOL, pool, target.prototype);
    }

    pool.registerMethod(...parameters);
  };
}

Method.getPool = function (targetPrototype: object) {
  const pool = Reflect.getMetadata(METHOD_POOL, targetPrototype) as MethodPool;
  if (!(pool instanceof MethodPool)) return null;
  return pool;
};
