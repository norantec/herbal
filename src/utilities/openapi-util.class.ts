import { Constructor } from 'type-fest';
import { NestUtil } from './nest-util.class';
import { OpenAPIObject } from 'openapi3-ts/oas31';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { getControllerName, getMethodPool, isHerbalController } from '../core';

export class OpenAPIUtil {
  public static generateDocumentMap({
    Module,
    groups,
    openAPIObject,
    openAPIPrefix,
  }: {
    groups?: string[];
    Module?: Constructor<any>;
    openAPIObject?: OpenAPIObject;
    openAPIPrefix?: string;
  }) {
    return (Array.isArray(groups) ? Array.from(new Set(groups.concat(['default']))) : ['default']).reduce(
      (result, groupId) => {
        const openAPIDocument = { ...openAPIObject, paths: {} };
        NestUtil.getControllerClasses(Module).forEach((Class) => {
          if (StringUtil.isFalsyString(Class?.name) || !isHerbalController(Class)) return;
          const controllerName = getControllerName(Class);
          const pool = getMethodPool(Class.prototype);
          if (StringUtil.isFalsyString(controllerName) || pool === null) return;
          Object.entries(pool.getOpenAPIPathsObject(groupId === 'default' ? undefined : groupId)).forEach(
            ([pathname, schemas]) => {
              openAPIDocument.paths[
                ['/', openAPIPrefix ?? '', controllerName, pathname].join('').replace(/^\/+/g, '/')
              ] = schemas;
            },
          );
        });
        result[groupId] = openAPIDocument;
        return result;
      },
      {},
    );
  }
}
