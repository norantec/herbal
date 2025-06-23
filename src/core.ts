import 'reflect-metadata';
import { BadRequestException, Body, NotFoundException, Post, Req } from '@nestjs/common';
import { HeaderUtil } from '@open-norantec/utilities/dist/header-util.class';
import { z, ZodAny, ZodError } from 'zod';
import * as _ from 'lodash';
import { HttpResponseBody } from './types/http-response-body.type';
import { Request } from './types/request.type';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';

export * from '@nestjs/core';

export interface MethodContext<IS extends z.Schema<any>> {
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
        callback: (context: MethodContext<IS>) => Promise<z.infer<OS>>,
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

    @Post('*')
    private async handler(@Req() request: Request, @Body() input: unknown): Promise<HttpResponseBody<any>> {
        const methodHandler: MethodHandler<z.Schema<any>, z.Schema<any>> = this[request?.methodName];
        if (typeof methodHandler === 'function') {
            return {
                data: await methodHandler(request, input, HeaderUtil.parse(request.headers ?? {})).then(
                    (response) => response?.response,
                ),
                token: StringUtil.isFalsyString(request?.authenticateResult?.nextToken)
                    ? null
                    : request.authenticateResult!.nextToken!,
            };
        } else {
            throw new NotFoundException();
        }
    }
}
