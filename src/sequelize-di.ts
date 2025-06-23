/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */
import { BelongsToOptions } from 'sequelize';
import {
    BelongsTo as SequelizeBelongsTo,
    Column,
    Model,
    Table as SequelizeTable,
    TableOptions,
    ModelClassGetter,
    DataType,
    CreatedAt,
    UpdatedAt,
} from 'sequelize-typescript';
import { v4 as uuid } from 'uuid';
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

export class HerbalModel extends Model {
    @Column({ primaryKey: true, type: DataType.UUID, defaultValue: uuid })
    public id: string;

    @CreatedAt
    @Column({ field: 'created_at' })
    public createdAt: Date;

    @UpdatedAt
    @Column({ field: 'updated_at' })
    public updatedAt: Date;
}
