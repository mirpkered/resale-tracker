/** Local calendar date for date inputs; ISO UTC slicing can shift the day. */
export function localDateInputValue(date: Date = new Date()): string {
  const year=date.getFullYear()
  const month=String(date.getMonth()+1).padStart(2,'0')
  const day=String(date.getDate()).padStart(2,'0')
  return `${year}-${month}-${day}`
}
