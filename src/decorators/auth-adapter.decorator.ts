import 'reflect-metadata';
import * as _ from 'lodash';
import { Constructor } from 'type-fest';
import { AuthAdapter } from '../abstracts/auth-adapter.abstract.class';

const AUTH_ADAPTERS = Symbol();

export function AuthAdapters(adapters?: Constructor<AuthAdapter>[]): PropertyDecorator {
    return (target, propertyKey) => {
        Reflect.defineMetadata(AUTH_ADAPTERS, Array.isArray(adapters) ? adapters : [], target, propertyKey);
    };
}

AuthAdapters.getAdapters = (target: object, propertyKey: string): Constructor<AuthAdapter>[] => {
    const result = _.attempt(() => Reflect.getMetadata(AUTH_ADAPTERS, target, propertyKey));
    if (Array.isArray(result)) return result;
    return [];
};
