# Print the path of a Java 17+ runtime: newest WPILib JDK, else JAVA_HOME, else PATH.
$wpilib = Get-ChildItem 'C:\Users\Public\wpilib\*\jdk\bin\java.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if ($wpilib) { return $wpilib.FullName }
if ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\java.exe")) { return "$env:JAVA_HOME\bin\java.exe" }
return 'java'
