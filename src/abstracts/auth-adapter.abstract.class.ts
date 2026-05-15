import { Constructor } from 'type-fest';
import { Request } from 'express';
import { Transaction } from 'sequelize';
import { GetModuleFn } from '../types';

export interface AuthenticateReturn {
  challengeValue: string;
  identifier: string;
  forbidden?: boolean;
  nextToken?: string;
}

export interface AuthenticateResult extends AuthenticateReturn {
  AuthenticatorClass: Constructor<AuthAdapter>;
}

export abstract class AuthAdapter {
  public constructor(
    protected readonly request: Request,
    protected readonly getModule: GetModuleFn,
  ) {}
  public abstract match(): boolean;
  public abstract authenticate(transaction?: Transaction): Promise<AuthenticateReturn | null>;
}
