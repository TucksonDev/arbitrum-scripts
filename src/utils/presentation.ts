// Logging
export function printVerboseLog(logName: string, logContents: any): void {
  console.log('');
  console.log('**************************');
  console.log('** ' + logName);
  console.log('**************************');
  console.log(logContents);
  console.log('');
}
