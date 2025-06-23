import { Request as ExpressRequest } from 'express';
import { AuthenticateResult } from '../abstracts/auth-adapter.abstract.class';
import { Transaction } from 'sequelize';

export type Request = ExpressRequest & {
    methodName: string;
    traceId: string;
    authenticateResult?: AuthenticateResult;
    transaction?: Transaction;
};
