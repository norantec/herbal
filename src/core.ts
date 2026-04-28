import 'reflect-metadata';
import { NotFoundException, Post, Req } from '@nestjs/common';
import { HeaderUtil } from '@open-norantec/utilities/dist/header-util.class';
import { z } from 'zod';
import { HttpResponseBody } from './types/http-response-body.type';
import { Request } from './types/request.type';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { AttemptUtil } from '@open-norantec/utilities';
import { ControllerUtil, MethodCallContext } from './utilities/controller-util.class';

export * from '@nestjs/core';

export type MethodHandler<IS extends z.Schema<any>, OS extends z.Schema<any>> = (
  request: Request,
  input: unknown,
  headers: ReturnType<typeof HeaderUtil.parse>,
) => Promise<{ request: z.infer<IS>; response: z.infer<OS> }>;

export class HerbalController {
  @Post('*')
  private async $handleRequest(@Req() request: Request): Promise<HttpResponseBody<any>> {
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

  private async $call<IS extends z.Schema<any>>(name: string, context: MethodCallContext<IS>) {
    const callFn = ControllerUtil.getPool(this)?.getCallFn?.(name);
    if (typeof callFn !== 'function') throw new NotFoundException(`Method ${name} not found`);
    return await callFn(this, context);
  }
}
