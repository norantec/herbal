import 'reflect-metadata';
import * as _ from 'lodash';
import { Constructor } from 'type-fest';

const HIDE_IN_CLIENT = Symbol();

export function HideInClient(): PropertyDecorator {
    return (target, propertyKey) => {
        Reflect.defineMetadata(HIDE_IN_CLIENT, true, target, propertyKey);
    };
}

HideInClient.isHidden = (target: Constructor<any>, metadataKey: string) => {
    return _.attempt(() => Reflect.getMetadata(HIDE_IN_CLIENT, target.prototype, metadataKey)) === true;
};
