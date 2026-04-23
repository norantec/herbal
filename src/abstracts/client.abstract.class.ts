import 'reflect-metadata';
import { Constructor } from 'type-fest';
import { NestUtil } from '../utilities/nest-util.class';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { GroupsFactory } from '../decorators/client-groups.decorator';
import { getControllerName, isHerbalController } from '../utilities/controller-util.class';
import { OpenAPIObject } from 'zod-openapi/dist/openapi3-ts/dist/model/openapi31';
import { Method } from '../decorators/method.decorator';

export interface CreateClientOptions {
  Module: Constructor<any>;
  allowedClientGroupsFactory?: GroupsFactory;
}

export abstract class Client {
  protected document: OpenAPIObject = {
    openapi: '3.1.0',
    info: {
      title: 'API Documentation',
      version: '1.0.0',
    },
    paths: {},
  };

  public constructor(public readonly options: CreateClientOptions) {
    NestUtil.getControllerClasses(options.Module).forEach((Class) => {
      if (StringUtil.isFalsyString(Class?.name) || !isHerbalController(Class)) return;

      const controllerName = getControllerName(Class);
      const pool = Method.getPool(Class.prototype);

      if (StringUtil.isFalsyString(controllerName) || pool === null) return;

      Object.entries(pool.getOpenAPIPathsObject()).forEach(([pathname, schemas]) => {
        this.document.paths![[`/${controllerName}`, pathname].join('')] = schemas;
      });
    });
  }

  public abstract generateClientSourceFile(currentGroup?: string): string;
}
