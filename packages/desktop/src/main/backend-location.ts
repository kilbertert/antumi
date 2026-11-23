import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BackendLocation } from '../shared/backend-location'

// The user's choice of where the backend runs, kept beside the app's other preferences: it decides
// which core there is to ask, so it cannot be one of core's own settings.
export async function readBackendLocation(file: string): Promise<BackendLocation> {
  try {
    const parsed = BackendLocation.safeParse(JSON.parse(await readFile(file, 'utf8')))
    return parsed.success ? parsed.data : { kind: 'local' }
  } catch {
    return { kind: 'local' }
  }
}

export async function writeBackendLocation(file: string, location: BackendLocation): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify(location, null, 2))
  await rename(temporary, file)
}
