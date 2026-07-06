import { IsString, IsOptional, Length, Matches } from 'class-validator';

export class UpdateTagDto {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(4, 7)
  @Matches(/^#[0-9a-fA-F]{3,6}$/, { message: 'color must be a valid hex color (e.g. #ff0000)' })
  color?: string;
}
