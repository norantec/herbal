import { Global, Module } from '@nestjs/common';
import { LoggerService } from './logger.service';
import { RequestScopeModule } from 'nj-request-scope';

@Global()
@Module({
    imports: [RequestScopeModule],
    providers: [LoggerService],
    exports: [LoggerService],
})
export class LoggerModule {}
