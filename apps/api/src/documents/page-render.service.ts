import { StorageService } from '@docflow/core'
import { Injectable, NotFoundException } from '@nestjs/common'

/**
 * Рендер страницы документа в PNG для просмотрщика (ТЗ 5.2).
 *
 * Отклонение от ТЗ: страницы рисует mupdf на сервере, а не pdfjs-dist
 * в браузере. Причина техническая — координаты областей-источников
 * нормализованы к размерам страницы, которые сообщил mupdf на этапе OCR.
 * Рендер тем же движком гарантирует, что оверлеи лягут ровно; у другого
 * движка возможны расхождения в трактовке CropBox/MediaBox. Побочно исчезает
 * настройка worker'а pdfjs в сборке Next.js. Один и тот же путь работает
 * и для PDF, и для сканов: mupdf открывает изображение как документ.
 */
@Injectable()
export class PageRenderService {
  constructor(private readonly storage: StorageService) {}

  async render(
    storageKey: string,
    mimeType: string,
    pageNumber: number,
    targetWidth: number,
  ): Promise<Buffer> {
    const buffer = await this.storage.getBuffer(storageKey)
    const mupdf = await import('mupdf')

    const document = mupdf.Document.openDocument(buffer, mimeType)
    if (pageNumber < 1 || pageNumber > document.countPages()) {
      throw new NotFoundException(`Страница ${pageNumber} не найдена`)
    }

    const page = document.loadPage(pageNumber - 1)
    const [x0, , x1] = page.getBounds()
    const width = x1 - x0
    if (width <= 0) throw new NotFoundException('Страница пуста')

    const scale = targetWidth / width
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    )
    return Buffer.from(pixmap.asPNG())
  }
}
