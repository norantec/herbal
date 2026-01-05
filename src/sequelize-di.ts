/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import { BelongsToOptions, ModelAttributeColumnOptions } from 'sequelize';
import {
  BelongsTo as SequelizeBelongsTo,
  Model,
  Table as SequelizeTable,
  TableOptions,
  ModelClassGetter,
  Column,
  DataType,
} from 'sequelize-typescript';
import { Constructor } from 'type-fest';

export * from 'sequelize-typescript';

export function Table<M extends Model = Model>(options: TableOptions<M>) {
  return (target: Constructor<M>) => {
    const newOptions = !options ? {} : options;
    if (!Array.isArray(newOptions?.indexes)) newOptions.indexes = [];
    newOptions.indexes = Array.from(newOptions.indexes).concat({
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
  }
}
