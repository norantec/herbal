/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import { BelongsToOptions, ModelAttributeColumnOptions } from 'sequelize';
import {
  BelongsTo as SequelizeBelongsTo,
  Model,
  Table as SequelizeTable,
  TableOptions as SequelizeTableOptions,
  ModelClassGetter,
  Column,
  DataType,
} from 'sequelize-typescript';
import { Constructor } from 'type-fest';

export * from 'sequelize-typescript';

export interface TableOptions<M extends Model = Model> extends SequelizeTableOptions<M> {
  standaloneIndexes?: Array<string | { field: string; name?: string; unique?: string }>;
}

export function Table<M extends Model = Model>({ standaloneIndexes, ...options }: TableOptions<M>) {
  return (target: Constructor<M>) => {
    const newOptions = !options ? {} : options;

    if (!Array.isArray(newOptions?.indexes)) newOptions.indexes = [];

    newOptions.indexes = Array.from(newOptions.indexes)
      .concat({
        name: 'pagination',
        fields: ['id', 'created_at'],
      })
      .concat(
        Array.isArray(standaloneIndexes)
          ? standaloneIndexes
              .map((item, index) => {
                if (typeof item === 'string') {
                  if (item.length === 0) return null;
                  return {
                    name: `idx_standalone__${index}`,
                    fields: [item],
                  };
                } else if (typeof item?.field === 'string' && item.field.length > 0) {
                  return {
                    fields: [item.field],
                    name: StringUtil.isFalsyString(item?.name) ? `idx_standalone__${index}` : item.name,
                    unique: typeof item?.unique === 'boolean' ? item.unique : false,
                  };
                } else {
                  return null;
                }
              })
              .filter((item) => item !== null)
          : [],
      );

    SequelizeTable({
      ...newOptions,
      tableName: newOptions?.modelName,
      modelName: target.name,
    })(target);
  };
}

export function BelongsTo(associatedClassGetter: ModelClassGetter<{}, {}>, options?: BelongsToOptions): Function {
  return SequelizeBelongsTo(associatedClassGetter, {
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE',
    ...options,
  });
}

export function DateColumn(options: Partial<ModelAttributeColumnOptions>): Function {
  return (target: Constructor<any>, propertyName: string, propertyDescriptor?: PropertyDescriptor) => {
    Column({
      ...options,
      type: DataType.DATE,
      get(this: Model) {
        return this.getDataValue?.(propertyName)?.toISOString?.() ?? null;
      },
    })(target, propertyName, propertyDescriptor);
  };
}
