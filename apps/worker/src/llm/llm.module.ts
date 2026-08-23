import { ENV, type Env } from '@docflow/core'
import { Global, Module } from '@nestjs/common'
import { LLM_PROVIDER } from './llm-provider'
import { MockLlmProvider } from './mock-llm.provider'
import { OpenAiCompatibleLlmProvider } from './openai-compatible-llm.provider'

@Global()
@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.LLM_PROVIDER === 'openai_compatible'
          ? new OpenAiCompatibleLlmProvider({
              // loadEnv validates all required openai_compatible settings.
              baseUrl: env.LLM_BASE_URL!,
              apiKey: env.LLM_API_KEY!,
              model: env.LLM_MODEL!,
              timeoutMs: env.LLM_TIMEOUT_MS,
            })
          : new MockLlmProvider(),
    },
  ],
  exports: [LLM_PROVIDER],
})
export class LlmModule {}
