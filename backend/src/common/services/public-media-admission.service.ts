import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

export interface PublicMediaAdmission {
  release(): void;
}

export const PUBLIC_MEDIA_MAX_CONCURRENT_RESPONSES = 128;

/**
 * Process-wide upper bound for public media responses. Per-IP limits alone do not
 * bound slow responses, and rate limits can be crossed over multiple windows.
 */
@Injectable()
export class PublicMediaAdmissionService {
  private activeResponses = 0;

  acquire(): PublicMediaAdmission {
    if (this.activeResponses >= PUBLIC_MEDIA_MAX_CONCURRENT_RESPONSES) {
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'PUBLIC_MEDIA_CAPACITY_EXHAUSTED',
          message: '公开媒体连接繁忙，请稍后重试',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.activeResponses += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeResponses = Math.max(0, this.activeResponses - 1);
      },
    };
  }

  getActiveResponses(): number {
    return this.activeResponses;
  }
}
