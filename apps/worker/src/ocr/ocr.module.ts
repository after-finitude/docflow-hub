import { ENV, type Env } from '@docflow/core'
import { Module } from '@nestjs/common'
import { GoogleVisionOcrProvider } from './google-vision-ocr.provider'
import { MockOcrProvider } from './mock-ocr.provider'
import { OCR_PROVIDER } from './ocr-provider'
import { OcrProcessor } from './ocr.processor'

@Module({
  providers: [
    {
      provide: OCR_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.OCR_PROVIDER === 'google'
          ? new GoogleVisionOcrProvider({
              // loadEnv validates the key when OCR_PROVIDER=google.
              keyFile: env.GOOGLE_VISION_KEY_FILE!,
              integrationKeyFile: env.INTEGRATION_KEY_FILE!,
              renderDpi: env.OCR_RENDER_DPI,
              languageHints: env.OCR_LANGUAGE_HINTS.split(',').map((hint) => hint.trim()),
            })
          : new MockOcrProvider(),
    },
    OcrProcessor,
  ],
})
export class OcrModule {}
