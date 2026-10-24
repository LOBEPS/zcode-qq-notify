' qq-notify 看门狗隐藏启动器（计划任务用：避免弹出控制台窗口）
' 自定位：与本脚本同目录的 watchdog.mjs，无需命令行传参
Dim sh, dir, wd
Set sh = CreateObject("WScript.Shell")
dir = Replace(WScript.ScriptFullName, WScript.ScriptName, "")
wd = dir & "watchdog.mjs"
sh.Run "node """ & wd & """ --once", 0, False
