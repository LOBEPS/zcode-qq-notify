' 隐藏运行看门狗单次巡检（计划任务用：避免弹出控制台窗口）
Dim sh, wd
Set sh = CreateObject("WScript.Shell")
wd = Replace(WScript.Arguments(0), "/", "\")
sh.Run "node """ & wd & """ --once", 0, False
