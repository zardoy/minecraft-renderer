import { IndexedData } from 'minecraft-data'
import { EntityMesh, rendererSpecialHandled, EntityDebugFlags } from '../three/entity/EntityMesh'

export const displayEntitiesDebugList = (mcData: IndexedData) => {
  const version = mcData.version.minecraftVersion!

  // Create results container
  const container = document.createElement('div')
  container.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    max-height: 90vh;
    overflow-y: auto;
    background: rgba(0,0,0,0.8);
    color: white;
    padding: 20px;
    border-radius: 8px;
    font-family: monospace;
    min-width: 400px;
    z-index: 1000;
  `
  document.body.appendChild(container)

  // Add title
  const title = document.createElement('h2')
  title.textContent = 'Minecraft Entity Support'
  title.style.cssText = 'margin-top: 0; text-align: center;'
  container.appendChild(title)

  // Test entities
  const results: Array<{
    entity: string
    supported: boolean
    type?: 'obj' | 'bedrock' | 'gltf' | 'special'
    mappedFrom?: string
    textureMap?: boolean
    errors?: string[]
  }> = []
  const entityNames = Object.keys(
    mcData.entitiesArray.reduce((acc, entity) => {
      acc[entity.name] = true
      return acc
    }, {})
  )

  // Add loading indicator
  const loading = document.createElement('div')
  loading.textContent = 'Testing entities...'
  loading.style.textAlign = 'center'
  container.appendChild(loading)

  for (const entity of entityNames) {
    const debugFlags: EntityDebugFlags = {}

    if (rendererSpecialHandled.includes(entity)) {
      results.push({
        entity,
        supported: true,
        type: 'special'
      })
      continue
    }

    try {
      const { mesh: entityMesh } = new EntityMesh(version, entity, undefined, {}, debugFlags)
      // find the most distant pos child
      globalThis.objects ??= {}
      globalThis.objects[entity] = entityMesh

      results.push({
        entity,
        supported: !!debugFlags.type || rendererSpecialHandled.includes(entity),
        type: debugFlags.type,
        mappedFrom: debugFlags.tempMap,
        textureMap: debugFlags.textureMap,
        errors: debugFlags.errors
      })
    } catch (e) {
      console.error(e)
      results.push({
        entity,
        supported: false,
        mappedFrom: debugFlags.tempMap
      })
    }
  }

  // Remove loading indicator
  loading.remove()

  const createSection = (title: string, items: any[], filter: (item: any) => boolean) => {
    const section = document.createElement('div')
    section.style.marginBottom = '20px'

    const sectionTitle = document.createElement('h3')
    sectionTitle.textContent = title
    sectionTitle.style.textAlign = 'center'
    section.appendChild(sectionTitle)

    const list = document.createElement('ul')
    list.style.cssText = 'padding-left: 20px; list-style-type: none; margin: 0;'

    const filteredItems = items.filter(filter)
    for (const item of filteredItems) {
      const listItem = document.createElement('li')
      listItem.style.cssText = 'line-height: 1.4; margin: 8px 0;'

      const entityName = document.createElement('strong')
      entityName.style.cssText = 'user-select: text;-webkit-user-select: text;'
      entityName.textContent = item.entity
      listItem.appendChild(entityName)

      let text = ''
      if (item.mappedFrom) {
        text += ` -> ${item.mappedFrom}`
      }
      if (item.type) {
        text += ` - ${item.type}`
      }
      if (item.textureMap) {
        text += ' ⚠️'
      }
      if (item.errors) {
        text += ' ❌'
      }

      listItem.appendChild(document.createTextNode(text))
      list.appendChild(listItem)
    }

    section.appendChild(list)
    return { section, count: filteredItems.length }
  }

  // Sort results - bedrock first
  results.sort((a, b) => {
    if (a.type === 'bedrock' && b.type !== 'bedrock') return -1
    if (a.type !== 'bedrock' && b.type === 'bedrock') return 1
    return a.entity.localeCompare(b.entity)
  })

  // Add sections
  const sections = [
    {
      title: '❌ Unsupported Entities',
      filter: (r: any) => !r.supported && !r.mappedFrom
    },
    {
      title: '⚠️ Partially Supported Entities',
      filter: (r: any) => r.mappedFrom
    },
    {
      title: '✅ Supported Entities',
      filter: (r: any) => r.supported && !r.mappedFrom
    }
  ]

  for (const { title, filter } of sections) {
    const { section, count } = createSection(title, results, filter)
    if (count > 0) {
      container.appendChild(section)
    }
  }

  // log object with errors per entity
  const errors = results
    .filter(r => r.errors)
    .map(r => ({
      entity: r.entity,
      errors: r.errors
    }))
  console.log(errors)
}
