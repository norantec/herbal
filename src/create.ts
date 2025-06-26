import 'reflect-metadata';
import * as _ from 'lodash';
import { CorsOptions, CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import { Constructor } from 'type-fest';
import { NestUtil } from './utilities/nest-util.class';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { DECORATOR_NAME_PREFIX } from './transformers/reflect-declaration';
import { HideInClient } from './decorators/hide-in-client.decorator';
import {
    CanActivate,
    ExceptionFilter,
    NestApplicationOptions,
    NestInterceptor,
    PipeTransform,
    WebSocketAdapter,
} from '@nestjs/common';
import { isHerbalController } from './utilities/controller-util.class';

export type Resolver = <T>(Class: Constructor<T>) => Promise<T>;
export type TypeCustomizerFn = (dataTypeMapName: string, name: string, genericName: string) => string[];

export interface CreateOptions {
    Module: Constructor<any>;
    cors?: CorsOptions | CorsOptionsDelegate<any> | false;
    factoryOptions?: NestApplicationOptions;
    globalFilters?: ExceptionFilter[];
    globalGuards?: CanActivate[];
    globalInterceptors?: NestInterceptor[];
    globalPipes?: PipeTransform<any>[];
    uses?: any[];
    websocketAdapter?: WebSocketAdapter;
    getListenPort: (resolver: Resolver) => number | Promise<number>;
    callback?: (resolver: Resolver) => void | Promise<void>;
    onBeforeBootstrap?: () => void | Promise<void>;
}

export interface SDKGeneratorOptions {
    Module: Constructor<any>;
}

export function create(options: CreateOptions) {
    return {
        options,
        generateClientSourceFile: (options: SDKGeneratorOptions) => {
            if (!options?.Module) throw new Error("Parameter 'Module' must be specified");

            const METHOD_TYPE_MAP_NAME = 'MethodTypeMap';
            const METHOD_TYPE_MAP_KEYS_NAME = 'MethodTypeMapKeys';
            const RESPONSE_CALLBACK_DATA_NAME = 'ResponseCallbackData';
            const REQUEST_OPTIONS_NAME = 'RequestOptions';
            const RESULT_TYPE_NAME = 'Result';
            const HTTP_RESPONSE_BODY_TYPE_NAME = 'HttpResponseBody';
            const REQUEST_METHOD_MAP_NAME = 'REQUEST_METHOD_MAP';
            const RESPONSE_CACHE_MAP_NAME = 'RESPONSE_CACHE_MAP';
            const REQUEST_BODY_TYPE_ANNOTATION = `${METHOD_TYPE_MAP_NAME}[T]['request']`;
            const RESULT_TYPE_ANNOTATION = `${RESULT_TYPE_NAME}<${HTTP_RESPONSE_BODY_TYPE_NAME}<${METHOD_TYPE_MAP_NAME}[T]['response']>>`;

            const methodTypeMapCodeLines = NestUtil.getControllerClasses(options.Module)
                .reduce((result, Class) => {
                    if (StringUtil.isFalsyString(Class?.name)) return result;
                    const controllerName = _.camelCase(Class.name.replace(/Controller$/g, ''));
                    if (StringUtil.isFalsyString(controllerName) || !isHerbalController(Class)) {
                        return result;
                    }
                    const metadataNames: string[] = Reflect.getMetadataKeys(Class.prototype).filter(
                        (metadataName) => !StringUtil.isFalsyString(metadataName),
                    );
                    return result.concat(
                        metadataNames.reduce((result, metadataName) => {
                            const methodName = metadataName.slice(DECORATOR_NAME_PREFIX.length);

                            if (
                                StringUtil.isFalsyString(metadataName) ||
                                !metadataName.startsWith(DECORATOR_NAME_PREFIX) ||
                                HideInClient.isHidden(Class, methodName)
                            ) {
                                return result;
                            }

                            const scopeIdentifier = `/${controllerName}/${methodName}`;

                            return result.concat(
                                [`'${scopeIdentifier}'`, `${Reflect.getMetadata(metadataName, Class.prototype)};`].join(
                                    ': ',
                                ),
                            );
                        }, [] as string[]),
                    );
                }, [] as string[])
                .map((line) => `    ${line}`);

            methodTypeMapCodeLines.unshift(`export interface ${METHOD_TYPE_MAP_NAME} {`);
            methodTypeMapCodeLines.push('}');

            return [
                "import * as hash from 'object-hash';",
                "import * as _ from 'lodash';",
                `\n${methodTypeMapCodeLines.join('\n')}`,
                `\ntype ${METHOD_TYPE_MAP_KEYS_NAME} = keyof ${METHOD_TYPE_MAP_NAME};`,
                `\ntype ${RESPONSE_CALLBACK_DATA_NAME} = {`,
                `    [K in ${METHOD_TYPE_MAP_KEYS_NAME}]: {`,
                '        url: K;',
                `    } & { response: ${METHOD_TYPE_MAP_NAME}[K]['response']; };`,
                '};',
                `\nexport type ${HTTP_RESPONSE_BODY_TYPE_NAME}<T> = {`,
                '    data: T;',
                '    token: string | null;',
                '};',
                `\nexport interface ${REQUEST_OPTIONS_NAME} extends RequestInit {`,
                '    headers?: Record<string, any>;',
                '    ignoreCache?: boolean;',
                '    prefix?: string;',
                '    timeout?: number;',
                '    getAuthorizationCredential?: () => string;',
                `    onResponse?: (response: ${RESPONSE_CALLBACK_DATA_NAME}) => void | Promise<void>;`,
                '}',
                `\nexport interface ${RESULT_TYPE_NAME}<T> {`,
                '    status: number;',
                '    statusText: string;',
                '    error?: Error;',
                '    headers?: Record<string, any>;',
                `    response?: T;`,
                '}',
                '\nexport class Client {',
                `    public constructor(private readonly options: ${REQUEST_OPTIONS_NAME} = {}) {}`,
                `\n    protected readonly ${REQUEST_METHOD_MAP_NAME} = new Map<keyof ${METHOD_TYPE_MAP_NAME}, (...params: any[]) => Promise<unknown>>();`,
                `\n    protected readonly ${RESPONSE_CACHE_MAP_NAME} = new Map<string, ${RESULT_TYPE_NAME}<unknown>>();`,
                `\n    public createRequest<T extends keyof ${METHOD_TYPE_MAP_NAME}>(url: T): (requestBody?: ${REQUEST_BODY_TYPE_ANNOTATION}, options?: ${REQUEST_OPTIONS_NAME}) => Promise<${RESULT_TYPE_ANNOTATION}> {`,
                `        if (typeof this.${REQUEST_METHOD_MAP_NAME}.get(url) !== 'function') {`,
                `            this.${REQUEST_METHOD_MAP_NAME}.set(url, (requestBody?: ${REQUEST_BODY_TYPE_ANNOTATION}, options?: ${REQUEST_OPTIONS_NAME}) => this.request.call(this, url, requestBody, options));`,
                '        }',
                `        return this.${REQUEST_METHOD_MAP_NAME}.get(url) as (requestBody?: ${REQUEST_BODY_TYPE_ANNOTATION}, options?: ${REQUEST_OPTIONS_NAME}) => Promise<${RESULT_TYPE_ANNOTATION}>;`,
                '    }',
                `\n    public async request<T extends keyof ${METHOD_TYPE_MAP_NAME}>(url: T, requestBody?: ${REQUEST_BODY_TYPE_ANNOTATION}, options?: Omit<${REQUEST_OPTIONS_NAME}, 'getAuthorizationCredential'>): Promise<${RESULT_TYPE_ANNOTATION}> {`,
                '        const requestHash = hash(requestBody ?? null);',
                "        const finalOptions = _.merge({}, this?.options, _.omit(options, ['getAuthorizationCredential']));",
                '        const { getAuthorizationCredential, onResponse, ignoreCache, timeout, prefix, ...requestOptions } = finalOptions;',
                `        if (this.${RESPONSE_CACHE_MAP_NAME}.has(requestHash) && !ignoreCache) {`,
                `            return this.${RESPONSE_CACHE_MAP_NAME}.get(requestHash) as ${RESULT_TYPE_ANNOTATION};`,
                '        }',
                '        const credential = getAuthorizationCredential?.();',
                '        const abortController = new AbortController();',
                '        if (timeout > 0) {',
                '            setTimeout(() => {',
                '                abortController.abort();',
                '            }, timeout);',
                '        }',
                `        const result: ${RESULT_TYPE_ANNOTATION} = await fetch((prefix ?? '') + url, {`,
                '            ...requestOptions,',
                '            body: JSON.stringify(requestBody),',
                "            method: 'POST',",
                '            signal: abortController.signal,',
                '            headers: {',
                '                ...requestOptions?.headers,',
                "                'Content-Type': 'application/json',",
                "                Authorization: (typeof credential === 'string' && credential.length > 0) ? credential : finalOptions?.headers?.Authorization,",
                '            },',
                '        }).then((response) => {',
                '            const status = response?.status;',
                '            const statusText = response?.statusText;',
                '            const headers = Array.from(response?.headers?.entries?.() ?? []).reduce((result, [key, value]) => {',
                "                if (typeof key !== 'string' || key.length === 0) return result;",
                '                result[key] = value;',
                '                return result;',
                '            }, {});',
                '            if (!response?.ok) {',
                '                return response.text().then((errorText) => ({ error: new Error(errorText), response: null, headers, status, statusText }));',
                '            }',
                '            return response.json().then((response) => ({ error: null, response, headers, status, statusText }));',
                '        });',
                `        onResponse?.(result?.response as unknown as ${RESPONSE_CALLBACK_DATA_NAME});`,
                `        this.${RESPONSE_CACHE_MAP_NAME}.set(requestHash, result);`,
                '        return result;',
                '    }',
                '}\n',
            ].join('\n');
        },
    };
}
