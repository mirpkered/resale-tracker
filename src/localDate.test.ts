import { describe, expect, it } from 'vitest'
import { localDateInputValue } from './localDate'

describe('local date input default',()=>{
  it('uses the device local calendar date instead of slicing a UTC ISO string',()=>{
    const localEvening=new Date(2026,10,25,23,59,0)
    expect(localDateInputValue(localEvening)).toBe('2026-11-25')
    const localMorning=new Date(2026,10,26,0,1,0)
    expect(localDateInputValue(localMorning)).toBe('2026-11-26')
  })
})
