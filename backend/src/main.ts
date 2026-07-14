import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { LockdownGate } from './lockdown/lockdown.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Blackout gate FIRST — before helmet, body parsing, auth, and routing,
  // covering every path including the un-prefixed wake URL (spec §7.4).
  app.use(app.get(LockdownGate).handler());

  app.use(helmet());
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  // The wake URL is answered by LockdownMiddleware before routing, so the
  // global prefix never applies to it.
  app.setGlobalPrefix('api');

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`LeadTrace backend listening on :${port}`);
}
bootstrap();
