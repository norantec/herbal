import { Constructor } from 'type-fest';

export * from './request.type';
export * from './http-response-body.type';

export type GetModuleFn = <TInput = any, TResult = TInput>(
  typeOrToken: Constructor<TInput> | Function | string | symbol,
  options: {
    /**
     * If enabled, lookup will only be performed in the host module.
     * @default true
     */
    strict?: boolean;
    /** This indicates that only the first instance registered will be returned. */
    each?: undefined | false;
  },
) => TResult;
