import 'reflect-metadata';
import { BadRequestException, Inject, NotFoundException, Post, Req } from '@nestjs/common';
import { HeaderUtil } from '@open-norantec/utilities/dist/header-util.class';
import { z, ZodAny, ZodError } from 'zod';
import * as _ from 'lodash';
import { HttpResponseBody } from './types/http-response-body.type';
import { Request } from './types/request.type';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { AttemptUtil } from '@open-norantec/utilities';
import { ModuleRef } from '@nestjs/core';
import { ControllerUtil, MethodCallContext } from './utilities/controller-util.class';

export * from '@nestjs/core';

interface LegacyMethodContext<IS extends z.Schema<any>> {
  headers: ReturnType<typeof HeaderUtil.parse>;
  input: z.infer<IS>;
  request: Request;
}

export type MethodHandler<IS extends z.Schema<any>, OS extends z.Schema<any>> = (
  request: Request,
  input: unknown,
  headers: ReturnType<typeof HeaderUtil.parse>,
) => Promise<{ request: z.infer<IS>; response: z.infer<OS> }>;

export class HerbalController {
  protected registerMethod = <IS extends z.Schema<any>, OS extends z.Schema<any>>(
    inputSchema: IS,
    outputSchema: OS,
    callback: (context: LegacyMethodContext<IS>) => Promise<z.infer<OS>>,
  ): MethodHandler<IS, OS> => {
    return async (request, rawInput, headers) => {
      const input = inputSchema instanceof ZodAny ? rawInput : _.attempt(() => inputSchema.parse(rawInput));

      if (input instanceof Error) {
        if (input instanceof ZodError) {
          throw new BadRequestException({
            invalidParams: input?.issues?.map?.((item) => item?.path?.join?.('.')) ?? [],
          });
        }
        throw input;
      }

      const responseData = await callback({ input, headers, request });

      return {
        request: input,
        response: outputSchema instanceof ZodAny ? responseData : outputSchema.parse(responseData),
      };
    };
  };

  @Inject(ModuleRef)
  protected moduleRef!: ModuleRef;

  @Post('*')
  private async $handleRequest(@Req() request: Request): Promise<HttpResponseBody<any>> {
    // const methodHandler: MethodHandler<z.Schema<any>, z.Schema<any>> = this[request?.methodName];
    // const parsedBody = _.attempt(() => JSON.parse(request?.rawBody || '') as Record<string, unknown>);
    // try {
    //   if (typeof methodHandler === 'function') {
    //     const result = {
    //       data: await methodHandler(
    //         request,
    //         parsedBody instanceof Error ? undefined : parsedBody,
    //         HeaderUtil.parse(request.headers ?? {}),
    //       ).then((response) => response?.response),
    //       token: StringUtil.isFalsyString(request?.authenticateResult?.nextToken)
    //         ? null
    //         : request.authenticateResult!.nextToken!,
    //     };
    //     try {
    //       await request?.transaction?.commit?.();
    //     } catch {}
    //     return result;
    //   } else {
    //     try {
    //       await request?.transaction?.rollback?.();
    //     } catch {}
    //     throw new NotFoundException();
    //   }
    // } catch (error) {
    //   throw error;
    // }

    try {
      const result = {
        data: await this.$call(request.methodName!, {
          authenticateResult: request.authenticateResult,
          headers: HeaderUtil.parse(request.headers ?? {}),
          methodName: request.methodName,
          rawBody: request.rawBody,
          traceId: request.traceId,
          transaction: request.transaction,
          url: request.originalUrl,
          controller: this,
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

  private async $call<IS extends z.Schema<any>>(name: string, context: MethodCallContext<IS, typeof this>) {
    const callFn = ControllerUtil.getPool(this)?.getCallFn?.(name);
    if (typeof callFn !== 'function') throw new NotFoundException(`Method ${name} not found`);
    return await callFn(context);
  }
}
