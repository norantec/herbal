import { Constructor } from 'type-fest';
import { Client as ClientFactory, CreateClientOptions } from '../abstracts/client.abstract.class';

class Client {
  public constructor(public readonly instance: ClientFactory) {}
}

export function isClient(input: any) {
  return input instanceof Client;
}

export function createClient(Class: Constructor<ClientFactory>, options: CreateClientOptions) {
  return new Client(new Class(options));
}
