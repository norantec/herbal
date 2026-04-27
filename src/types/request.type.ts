import { Request as ExpressRequest } from 'express';
import { AuthenticateResult } from '../abstracts/auth-adapter.abstract.class';
import { Transaction } from 'sequelize';
// import { ModuleRef } from '@nestjs/core';

export interface RequestContext {
  methodName: string;
  // moduleRef: ModuleRef;
  rawBody: string | null;
  traceId: string;
  authenticateResult?: AuthenticateResult;
  transaction?: Transaction;
}

export type Request = ExpressRequest & RequestContext;
