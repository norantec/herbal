import 'reflect-metadata';
import { SchemaObject, RequestBodyObject, ResponseObject } from 'zod-openapi/dist/openapi3-ts/dist/model/openapi31';
import { Client, CreateClientOptions } from '../abstracts/client.abstract.class';
import { compile } from 'json-schema-to-typescript';

export class TypeScriptClient extends Client implements Client {
  public constructor(options: CreateClientOptions) {
    super(options);
  }

  public async generateClientSourceFile() {
    const options = this.options;

    if (!options?.Module) throw new Error("Parameter 'Module' must be specified");

    const METHOD_TYPE_MAP_NAME = 'MethodTypeMap';
    const METHOD_TYPE_MAP_KEYS_NAME = 'MethodTypeMapKeys';
    const RESPONSE_CALLBACK_DATA_NAME = 'ResponseCallbackData';
    const REQUEST_OPTIONS_NAME = 'RequestOptions';
    const RESULT_TYPE_NAME = 'Result';
    const REQUEST_METHOD_MAP_NAME = 'REQUEST_METHOD_MAP';
    const RESPONSE_CACHE_MAP_NAME = 'RESPONSE_CACHE_MAP';
    const REQUEST_BODY_TYPE_ANNOTATION = `${METHOD_TYPE_MAP_NAME}[T]['request']`;
    const RESULT_TYPE_ANNOTATION = `${RESULT_TYPE_NAME}<${METHOD_TYPE_MAP_NAME}[T]['response']>`;
    const methodTypeMapCodeLines: string[] = [];

    for (const [pathname, schema] of Object.entries(this.document.paths ?? {})) {
      const requestSchema = (schema?.post?.requestBody as RequestBodyObject)?.content?.['application/json']?.schema;
      const responseSchema = (schema?.post?.responses?.['200'] as ResponseObject)?.content?.['application/json']
        ?.schema;

      if (!requestSchema && !responseSchema) continue;

      const requestTypeLiteral = await this.schemaToTypeScriptLiteral(requestSchema as SchemaObject);
      const responseTypeLiteral = await this.schemaToTypeScriptLiteral(responseSchema as SchemaObject);

      methodTypeMapCodeLines.push(
        [`  '${pathname}': {`, ` request: ${requestTypeLiteral};`, ` response: ${responseTypeLiteral};`, ' };'].join(
          '',
        ),
      );
    }

    methodTypeMapCodeLines.unshift(`export interface ${METHOD_TYPE_MAP_NAME} {`);
    methodTypeMapCodeLines.push('}');

    return [
      "import * as hash from 'object-hash';",
      "import * as _ from 'lodash';",
      `\n${methodTypeMapCodeLines.join('\n')}`,
      `\ntype ${METHOD_TYPE_MAP_KEYS_NAME} = keyof ${METHOD_TYPE_MAP_NAME};`,
      `\ntype ${RESPONSE_CALLBACK_DATA_NAME}<K extends ${METHOD_TYPE_MAP_KEYS_NAME}> = {`,
      '  url: K;',
      `  result: ${RESULT_TYPE_NAME}<${METHOD_TYPE_MAP_NAME}[K]['response']>;`,
      '};',
      `\nexport interface ${REQUEST_OPTIONS_NAME} extends RequestInit {`,
      '  headers?: Record<string, any>;',
      '  ignoreCache?: boolean;',
      '  prefix?: string;',
      '  timeout?: number;',
      '  getAuthorizationCredential?: () => string;',
      `  onRequest?: (context: { cached: boolean; id: string; options: Omit<${REQUEST_OPTIONS_NAME}, 'getAuthorizationCredential' | 'onRequest' | 'onResponse'>; prefix: string | undefined; requestBody: string; url: string; }) => void | Promise<void>;`,
      `  onResponse?: <K extends ${METHOD_TYPE_MAP_KEYS_NAME}>(response: ${RESPONSE_CALLBACK_DATA_NAME}<K>, id: string) => void | Promise<void>;`,
      '}',
      `\nexport interface ${RESULT_TYPE_NAME}<T> {`,
      '  error: Error | null;',
      `  response: T | null;`,
      '  status: number;',
      '  statusText: string;',
      '  headers?: Record<string, any>;',
      '}',
      '\nexport class Client {',
      `  public constructor(private readonly options: ${REQUEST_OPTIONS_NAME} = {}) {}`,
      `\n  protected readonly ${REQUEST_METHOD_MAP_NAME} = new Map<keyof ${METHOD_TYPE_MAP_NAME}, (...params: any[]) => Promise<unknown>>();`,
      `\n  protected readonly ${RESPONSE_CACHE_MAP_NAME} = new Map<string, ${RESULT_TYPE_NAME}<unknown>>();`,
      `\n  public createRequest<T extends keyof ${METHOD_TYPE_MAP_NAME}>(url: T): (requestBody?: ${REQUEST_BODY_TYPE_ANNOTATION}, options?: ${REQUEST_OPTIONS_NAME}) => Promise<${RESULT_TYPE_ANNOTATION}> {`,
      `    if (typeof this.${REQUEST_METHOD_MAP_NAME}.get(url) !== 'function') {`,
      `      this.${REQUEST_METHOD_MAP_NAME}.set(url, (requestBody?: ${REQUEST_BODY_TYPE_ANNOTATION}, options?: ${REQUEST_OPTIONS_NAME}) => this.request.call(this, url, requestBody, options));`,
      '    }',
      `    return this.${REQUEST_METHOD_MAP_NAME}.get(url) as (requestBody?: ${REQUEST_BODY_TYPE_ANNOTATION}, options?: ${REQUEST_OPTIONS_NAME}) => Promise<${RESULT_TYPE_ANNOTATION}>;`,
      '  }',
      `\n  public async request<T extends keyof ${METHOD_TYPE_MAP_NAME}>(url: T, requestBody?: ${REQUEST_BODY_TYPE_ANNOTATION}, options?: Omit<${REQUEST_OPTIONS_NAME}, 'getAuthorizationCredential' | 'onRequest' | 'onResponse'>): Promise<${RESULT_TYPE_ANNOTATION}> {`,
      '    const id = `${Math.random().toString(32).slice(2)}${Date.now().toString(16)}`;',
      '    const requestHash = hash(requestBody ?? null);',
      '    const requestBodyString = JSON.stringify(requestBody);',
      "    const finalOptions = _.merge({}, this?.options, _.omit(options, ['getAuthorizationCredential', 'onRequest', 'onResponse']));",
      "    const onRequestOptions = _.omit(finalOptions, ['getAuthorizationCredential', 'onRequest', 'onResponse']);",
      '    const { getAuthorizationCredential, onResponse, onRequest, ignoreCache, timeout, prefix, ...requestOptions } = finalOptions;',
      `    if (this.${RESPONSE_CACHE_MAP_NAME}.has(requestHash) && !ignoreCache) {`,
      '      onRequest?.({',
      '        prefix,',
      '        url,',
      '        requestBody: requestBodyString,',
      '        cached: true,',
      '        options: onRequestOptions,',
      '        id,',
      '      });',
      `      return this.${RESPONSE_CACHE_MAP_NAME}.get(requestHash) as ${RESULT_TYPE_ANNOTATION};`,
      '    }',
      '    onRequest?.({',
      '      prefix,',
      '      url,',
      '      id,',
      '      requestBody: requestBodyString,',
      '      cached: false,',
      '      options: onRequestOptions,',
      '    });',
      '    const credential = getAuthorizationCredential?.();',
      '    const abortController = new AbortController();',
      '    if (timeout! > 0) {',
      '      setTimeout(() => {',
      '        abortController.abort();',
      '      }, timeout);',
      '    }',
      `    const result: ${RESULT_TYPE_ANNOTATION} = await fetch((prefix ?? '') + url, {`,
      '      ...requestOptions,',
      '      body: JSON.stringify(requestBody),',
      "      method: 'POST',",
      '      signal: abortController.signal,',
      '      headers: {',
      '        ...requestOptions?.headers,',
      "        'Content-Type': 'application/json',",
      "        Authorization: (typeof credential === 'string' && credential.length > 0) ? credential : finalOptions?.headers?.Authorization,",
      '      },',
      '    }).then((response) => {',
      '      const status = response?.status;',
      '      const statusText = response?.statusText;',
      '      const headers = Array.from(response?.headers?.entries?.() ?? []).reduce((result, [key, value]) => {',
      "        if (typeof key !== 'string' || key.length === 0) return result;",
      '        result[key] = value;',
      '        return result;',
      '      }, {});',
      '      if (!response?.ok) {',
      '        return response.text().then((errorText) => ({ error: new Error(errorText), response: null, headers, status, statusText }));',
      '      }',
      `      return response.json().then((response) => ({ error: null, response, headers, status, statusText } as ${RESULT_TYPE_ANNOTATION}));`,
      "    }).catch((error) => Promise.resolve({ error, response: null, headers: {}, status: 0, statusText: '' }));",
      `    onResponse?.({ url, result }, id);`,
      `    this.${RESPONSE_CACHE_MAP_NAME}.set(requestHash, result);`,
      '    return result;',
      '  }',
      '}\n',
    ].join('\n');
  }

  private async schemaToTypeScriptLiteral(schema: SchemaObject) {
    const interfaceName = `Interface${Math.random().toString(36).slice(2)}`;
    return await compile(schema as Parameters<typeof compile>[0], interfaceName, {
      format: true,
      bannerComment: '',
      additionalProperties: false,
      unknownAny: false,
      style: {
        singleQuote: true,
        semi: true,
        trailingComma: 'none',
      },
    }).then((code) => {
      return code
        .trim()
        .split('\n')
        .map((line, index) => `${index === 0 ? '' : ' '}${line.trim()}`)
        .join('')
        .replace(/^export\s+interface\s+Interface[a-zA-Z0-9-_]+\s+\{/, '{');
    });
  }
}
