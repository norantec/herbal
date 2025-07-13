import 'reflect-metadata';
import * as _ from 'lodash';
import { Constructor } from 'type-fest';

const CLIENT_GROUPS = Symbol();

export type GroupsFactory = (defaultGroupName: string) => string[] | null | undefined;
// export type Groups = ReturnType<GroupFactory> | GroupFactory;

export function ClientGroups(groupsFactory?: GroupsFactory): PropertyDecorator {
    return (target, propertyKey) => {
        Reflect.defineMetadata(CLIENT_GROUPS, groupsFactory, target, propertyKey);
    };
}

ClientGroups.shouldShowInClient = (
    target: Constructor<any>,
    metadataKey: string,
    allowedClientGroupsFactory?: GroupsFactory,
) => {
    const defaultGroupName = `default:${Math.random().toString(32).slice(2)}`;
    const finalAllowedClientGroups = (() => {
        if (typeof allowedClientGroupsFactory === 'function') {
            const result = allowedClientGroupsFactory(defaultGroupName);
            return !Array.isArray(result) ? [] : result;
        } else {
            return [defaultGroupName];
        }
    })();
    const methodClientGroups = (() => {
        const decoratorValue: GroupsFactory = _.attempt(() =>
            Reflect.getMetadata(CLIENT_GROUPS, target.prototype, metadataKey),
        );
        if (typeof decoratorValue === 'function') {
            const result = decoratorValue(defaultGroupName);
            return !Array.isArray(result) ? [] : result;
        } else {
            return [defaultGroupName];
        }
    })();
    return _.intersection(finalAllowedClientGroups, methodClientGroups).length > 0;
};
