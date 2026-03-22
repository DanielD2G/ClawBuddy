import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { env } from '../env.js'

let checkpointerPromise: Promise<PostgresSaver> | null = null

export async function getLangGraphCheckpointer() {
  if (!checkpointerPromise) {
    checkpointerPromise = (async () => {
      const saver = PostgresSaver.fromConnString(env.DATABASE_URL, {
        schema: 'langgraph',
      })
      await saver.setup()
      return saver
    })()
  }

  return checkpointerPromise
}
