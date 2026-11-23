import { Platform } from 'react-native'
import { File, Paths } from 'expo-file-system'
import { Asset, requestPermissionsAsync } from 'expo-media-library'

// A picture from the chat into the phone's photos. Android 10 and later add it through
// MediaStore with no permission; older ones, and iOS, ask on the first save.

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export async function saveToPhotos(dataUri: string): Promise<boolean> {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri)
  const mime = match?.[1]
  const base64 = match?.[2]
  if (!mime || !base64) return false
  const asks = Platform.OS === 'ios' || (Platform.OS === 'android' && Platform.Version < 29)
  if (asks && !(await requestPermissionsAsync(true)).granted) return false
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const file = new File(Paths.cache, `Antumi-${stamp}.${EXTENSIONS[mime] ?? 'png'}`)
  try {
    await file.write(base64, { encoding: 'base64' })
    await Asset.create(file.uri)
    return true
  } catch {
    return false
  } finally {
    if (file.exists) file.delete()
  }
}
