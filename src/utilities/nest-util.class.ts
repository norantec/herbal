import 'reflect-metadata';
import * as _ from 'lodash';
import { Constructor } from 'type-fest';

export class NestUtil {
    public static getControllerClasses(Class: Constructor<any>) {
        let importedModules: Constructor<any>[] = Reflect.getMetadata('imports', Class);

        if (!Array.isArray(importedModules)) {
            importedModules = [];
        }

        return importedModules.reduce((result: Constructor<any>[], ImportedModule) => {
            let controllerClasses = Reflect.getMetadata('controllers', ImportedModule);

            if (!Array.isArray(controllerClasses)) {
                controllerClasses = _.get(ImportedModule, 'controllers');
            }

            if (!Array.isArray(controllerClasses)) {
                return result;
            }

            return result.concat(controllerClasses);
        }, [] as Constructor<any>[]);
    }
}
