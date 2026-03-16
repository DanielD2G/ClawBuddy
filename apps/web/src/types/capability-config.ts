export interface ConfigFieldDefinition {
  key: string
  label: string
  type: 'string' | 'password' | 'select' | 'textarea'
  required: boolean
  description?: string
  envVar: string
  default?: string
  options?: Array<{ label: string; value: string }>
  placeholder?: string
}
