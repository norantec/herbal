import 'reflect-metadata';
import {
  SchemaObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
} from 'zod-openapi/dist/openapi3-ts/dist/model/openapi31';
import { Client, CreateClientOptions } from '../abstracts/client.abstract.class';
import { NestUtil } from '../utilities/nest-util.class';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { getControllerName, isHerbalController } from '../utilities/controller-util.class';
import { Method } from '../decorators/method.decorator';

namespace OpenApiToTypescript {
  export interface Options {
    /**
     * @description
     * Whether to use 'interface' instead of 'type' for object definitions
     */
    useInterface?: boolean;
    /**
     * @description
     * Whether to export the generated types
     */
    export?: boolean;
    /**
     * @description
     * Whether to generate JSDoc comments from schema descriptions
     */
    generateJSDoc?: boolean;
    /**
     * @description
     * Whether to use 'unknown' instead of 'any' for unspecified types
     */
    preferUnknown?: boolean;
    /**
     * @description
     * Whether to generate code in a single line (no newlines)
     */
    singleLine?: boolean;
  }

  export interface TypeResult {
    code: string;
    name?: string;
  }
}

type SchemaOrRef = SchemaObject | ReferenceObject;

class OpenApiToTypescriptConverter {
  private options: Required<OpenApiToTypescript.Options>;

  constructor(options: OpenApiToTypescript.Options = {}) {
    this.options = {
      useInterface: false,
      export: true,
      generateJSDoc: true,
      preferUnknown: true,
      singleLine: true,
      ...options,
    };
  }

  /**
   * @description
   * Convert an OpenAPI schema to TypeScript type declaration
   */
  convert(schema: SchemaObject, name?: string): OpenApiToTypescript.TypeResult {
    const typeString = this.parseSchema(schema, 0, name);

    if (name) {
      const exportKeyword = this.options.export ? 'export ' : '';
      if (this.options.useInterface && schema.type === 'object' && schema.properties) {
        const code = `${exportKeyword}${typeString}`;
        return { code, name };
      }
      const code = `${exportKeyword}type ${name} = ${typeString};`;
      return { code, name };
    }

    return { code: typeString };
  }

  /**
   * @description
   * Generate TypeScript types from multiple named OpenAPI schemas
   */
  generateTypes(schemas?: Record<string, SchemaObject>): string {
    if (!schemas) return '';

    const lines: string[] = [];

    Object.entries(schemas).forEach(([name, schema]) => {
      const result = this.convert(schema, name);
      lines.push(result.code);
    });

    return lines.join('\n');
  }

  /**
   * @description
   * Convert Zod schema to TypeScript type declaration (convenience method)
   */
  static fromZodResult(
    result: { schema: SchemaObject },
    name?: string,
    options?: OpenApiToTypescript.Options,
  ): OpenApiToTypescript.TypeResult {
    const converter = new OpenApiToTypescriptConverter(options);
    return converter.convert(result.schema, name);
  }

  private parseSchema(schema: SchemaOrRef, depth: number = 0, name?: string): string {
    // Handle $ref
    if ('$ref' in schema && typeof schema.$ref === 'string') {
      return this.refToTypeName(schema.$ref);
    }

    const s = schema as SchemaObject;

    // Handle oneOf, anyOf, allOf
    if (s.oneOf) {
      return this.parseOneOf(s.oneOf, depth);
    }
    if (s.anyOf) {
      return this.parseAnyOf(s.anyOf, depth);
    }
    if (s.allOf) {
      return this.parseAllOf(s.allOf, depth);
    }

    // Handle different types
    switch (s.type) {
      case 'object':
        return this.parseObject(s, depth, name);
      case 'array':
        return this.parseArray(s, depth);
      case 'string':
        return this.parseString(s);
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      default:
        // Handle enum
        if (s.enum) {
          return this.parseEnum(s.enum);
        }
        if (Array.isArray(s.type)) {
          return s.type.join(' | ');
        }
        // Empty object means any/unknown
        if (Object.keys(s).length === 0 || (s.type === undefined && !s.enum)) {
          return this.options.preferUnknown ? 'unknown' : 'any';
        }
        return this.options.preferUnknown ? 'unknown' : 'any';
    }
  }

  private parseObject(schema: SchemaObject, depth: number, name?: string): string {
    // Handle additionalProperties (Record type)
    if (schema.additionalProperties && !schema.properties) {
      if (typeof schema.additionalProperties === 'boolean') {
        return 'Record<string, unknown>';
      }
      const valueType = this.parseSchema(schema.additionalProperties as SchemaObject, depth);
      return `Record<string, ${valueType}>`;
    }

    const properties = schema.properties || {};
    const required = schema.required || [];

    if (Object.keys(properties).length === 0) {
      if (schema.additionalProperties) {
        if (typeof schema.additionalProperties === 'boolean') {
          return 'Record<string, unknown>';
        }
        const valueType = this.parseSchema(schema.additionalProperties as SchemaObject, depth);
        return `Record<string, ${valueType}>`;
      }
      return 'Record<string, never>';
    }

    // If using interface and this is a named schema
    if (this.options.useInterface && name && depth === 0) {
      const props: string[] = [];
      Object.entries(properties).forEach(([key, propSchema]) => {
        const isRequired = required.includes(key);
        const tsType = this.parseSchema(propSchema, depth + 1);
        const optional = isRequired ? '' : '?';
        props.push(`${key}${optional}: ${tsType}`);
      });
      return `interface ${name} { ${props.join('; ')} }`;
    }

    // Generate inline object type (single line)
    const props: string[] = [];
    Object.entries(properties).forEach(([key, propSchema]) => {
      const isRequired = required.includes(key);
      const tsType = this.parseSchema(propSchema, depth + 1);
      const optional = isRequired ? '' : '?';
      props.push(`${key}${optional}: ${tsType}`);
    });

    return `{ ${props.join('; ')} }`;
  }

  private parseArray(schema: SchemaObject, depth: number): string {
    const items = schema.items;

    if (!items) {
      return 'unknown[]';
    }

    // Handle tuple-like arrays
    if (Array.isArray(items)) {
      const types = items.map((item) => this.parseSchema(item as SchemaOrRef, depth));
      return `[${types.join(', ')}]`;
    }

    const itemType = this.parseSchema(items as SchemaOrRef, depth);

    // Check if we need parentheses for union types
    if (itemType.includes('|') || itemType.includes('&')) {
      return `(${itemType})[]`;
    }

    return `${itemType}[]`;
  }

  private parseString(schema: SchemaObject): string {
    // If it's a string enum with single value, return literal type
    if (schema.enum) {
      return this.parseEnum(schema.enum);
    }
    return 'string';
  }

  private parseEnum(values: (string | number | boolean | null)[]): string {
    const literals = values.map((v) => {
      if (v === null) return 'null';
      if (typeof v === 'string') {
        return `'${v.replace(/'/g, "\\'")}'`;
      }
      return String(v);
    });
    return literals.join(' | ');
  }

  private parseOneOf(schemas: SchemaOrRef[], depth: number): string {
    const types = schemas.map((s) => this.parseSchema(s, depth));
    return types.join(' | ');
  }

  private parseAnyOf(schemas: SchemaOrRef[], depth: number): string {
    const types = schemas.map((s) => this.parseSchema(s, depth));
    return types.join(' | ');
  }

  private parseAllOf(schemas: SchemaOrRef[], depth: number): string {
    const types = schemas.map((s) => {
      const parsed = this.parseSchema(s, depth);
      return parsed;
    });

    // Filter out duplicates and join
    const uniqueTypes = [...Array.from(new Set(types))];
    if (uniqueTypes.length === 1) {
      return uniqueTypes[0];
    }

    return uniqueTypes.join(' & ');
  }

  private refToTypeName(ref: string): string {
    // Convert #/components/schemas/User to User
    const parts = ref.split('/');
    return parts[parts.length - 1] || 'unknown';
  }
}

/**
 * @description
 * Convert an OpenAPI schema object to TypeScript type declaration
 */
export function convertOpenApiToTypescript(
  schema: SchemaObject,
  name?: string,
  options?: OpenApiToTypescript.Options,
): OpenApiToTypescript.TypeResult {
  const converter = new OpenApiToTypescriptConverter(options);
  return converter.convert(schema, name);
}

export class TypeScriptClient extends Client implements Client {
  public constructor(public readonly options: CreateClientOptions) {
    super(options);
  }

  public generateClientSourceFile() {
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

    const methodTypeMapCodeLines = NestUtil.getControllerClasses(options.Module)
      .reduce((result, Class) => {
        if (StringUtil.isFalsyString(Class?.name) || !isHerbalController(Class)) return result;

        const controllerName = getControllerName(Class);
        const pool = Method.getPool(Class.prototype);

        if (StringUtil.isFalsyString(controllerName) || pool === null) return result;

        return result.concat(
          Object.entries(pool.getOpenAPIPathsObject())
            .map(([pathname, schema]) => {
              const requestSchema = (schema?.post?.requestBody as RequestBodyObject)?.content?.['application/json']
                ?.schema;
              const responseSchema = (schema?.post?.responses?.['200'] as ResponseObject)?.content?.['application/json']
                ?.schema;

              if (!requestSchema && !responseSchema) return null;

              return [
                `'/${controllerName}${pathname}': {`,
                ` request: ${convertOpenApiToTypescript(requestSchema as SchemaObject)?.code || 'any'};`,
                ` response: ${convertOpenApiToTypescript(responseSchema as SchemaObject)?.code || 'any'};`,
                ' };',
              ].join('');
            })
            .filter((value) => value !== null) as string[],
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
}
