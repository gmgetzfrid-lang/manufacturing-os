@echo off
setlocal
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" (
  "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -WindowStyle Normal -ExecutionPolicy RemoteSigned -File "%~dp0TracePoint_GUI_V1_0_11_Beta1.ps1" -Mode SelfTest
) else (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -WindowStyle Normal -ExecutionPolicy RemoteSigned -File "%~dp0TracePoint_GUI_V1_0_11_Beta1.ps1" -Mode SelfTest
)
pause
