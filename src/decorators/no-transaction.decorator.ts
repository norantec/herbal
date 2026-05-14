import 'reflect-metadata';
import * as _ from 'lodash';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';

const TRANSACTION_DISABLED = Symbol();

export function NoTransaction(): PropertyDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(TRANSACTION_DISABLED, true, target, propertyKey);
  };
}

NoTransaction.isDisabled = (target: object, propertyKey?: string): boolean => {
  if (StringUtil.isFalsyString(propertyKey)) return false;
  const result = _.attempt(() => Reflect.getMetadata(TRANSACTION_DISABLED, target, propertyKey!));
  return result === true;
};
