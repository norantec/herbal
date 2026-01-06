/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import { BelongsToOptions, IndexesOptions, ModelAttributeColumnOptions } from 'sequelize';
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

export interface TableOptions<M extends Model = Model> extends Omit<SequelizeTableOptions<M>, 'indexes'> {
  indexes?: Array<IndexesOptions | string>;
}

export function Table<M extends Model = Model>({ indexes, ...options }: TableOptions<M>) {
  return (target: Constructor<M>) => {
    const newOptions: SequelizeTableOptions<M> = !options ? {} : options;
    newOptions.indexes = [];
    newOptions.indexes = (
      Array.from(Array.isArray(indexes) ? indexes : []).map((item, index) => {
        if (typeof item === 'string') {
          return [
            {
              name: `sidx__${index}`,
              fields: [item],
            },
          ];
        }
        return item;
      }) as IndexesOptions[]
    ).concat({
      name: 'pagination',
      fields: ['id', 'created_at'],
    });
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
