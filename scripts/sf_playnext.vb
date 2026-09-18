Sub Main(ByVal parms As Object)
    Dim xmlhttp, url, payload, response, msgid, msgtxt
    ' Check if any parameters were passed'
    If parms Is Nothing Then
        hs.WriteLog("Script", "No parameters received.")
        Return
    End If

    ' If a single string or array element is passed'
    Dim inputStr As String = parms.ToString()
    
    ' Optional: Split multiple parameters separated by a pipe (|)'
    Dim parts As String() = inputStr.Split("|"c)
    
    If parts.Length >= 2 Then
        msgid = parts(0).Trim()
        msgtxt = parts(1).Trim()
    Else
	msgtxt = inputStr
    End If
    
    url = "http://192.168.1.160:3000/api/board/LCL836/play"
    
    ' Create the HTTP object
    xmlhttp = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    
    ' Open connection (Method, URL, Asynchronous=False)
    xmlhttp.open ("GET", url, False)
    
    ' Set necessary headers
    xmlhttp.setRequestHeader ("Content-Type", "application/json")
    ' xmlhttp.setRequestHeader ("Authorization", "Bearer YOUR_TOKEN_HERE") ' (Optional)
    
    ' Handle the response
    xmlhttp.send()
    response = xmlhttp.responseText
    hs.WriteLog ("HTTP GET", "Server returned: " & response)
    
    ' Clean up object memory
    xmlhttp = Nothing
End Sub