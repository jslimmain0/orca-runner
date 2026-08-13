# Reads a line of "pid,pid,..." from stdin and replies with a single JSON line
# containing each process's cumulative CPU time (ms) and RSS.
# No timer of its own -- the runner owns the cadence. Exits on 'exit' or EOF.
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'exit') { break }
  $result = @()
  foreach ($token in ($line -split ',')) {
    if ($token -match '^\d+$') {
      try {
        $p = Get-Process -Id ([int]$token) -ErrorAction Stop
        $result += [pscustomobject]@{ pid = $p.Id; cpuMs = [long]$p.TotalProcessorTime.TotalMilliseconds; rss = [long]$p.WorkingSet64 }
      } catch {}
    }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
}
