import type { InventoryItem } from './domain'
import { commandSaleDefaults, type ParsedSaleCommand } from './voiceCommand'

export interface QuickSaleInitial {
  platform?: string
  amountCents?: number | null
  amountMode?: 'total' | 'per_unit'
  quantity?: number
  feeCents?: number | null
  shippingCents?: number | null
  otherExpenseCents?: number | null
}

export function voiceSaleInitial(command: ParsedSaleCommand, item: InventoryItem): QuickSaleInitial {
  const values = commandSaleDefaults(command, item)
  return { platform: values.platform, amountCents: values.amountCents, amountMode: command.amountMode, quantity: command.quantity, feeCents: values.feeCents, shippingCents: values.shippingCents, otherExpenseCents: values.otherExpenseCents }
}
