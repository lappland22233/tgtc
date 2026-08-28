import 'dotenv/config';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from './database.config';

export const AppDataSource = new DataSource(createDatabaseOptions());
