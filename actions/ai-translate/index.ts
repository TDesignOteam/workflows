import * as core from '@actions/core'
import { main } from './main'

main().catch((error) => {
  core.setFailed(`ai-translate failed: ${error instanceof Error ? error.message : String(error)}`)
})
