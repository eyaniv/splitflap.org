Sub Main(ByVal parms As Object)
    ' 1. Type-safe declaration & object initialization
    Dim xmlhttp As Object = Nothing
    Dim url As String = ""
    Dim response As String = ""
    Dim msgid As String = ""
    Dim msgtxt As String = ""

    Try
        ' 2. Guard against completely null inputs
        If parms Is Nothing Then
            hs.WriteLog("Script Error", "No parameters received.")
            Return
        End If

        ' 3. Safely handle input conversions
        Dim inputStr As String = parms.ToString().Trim()
        If String.IsNullOrEmpty(inputStr) Then
            hs.WriteLog("Script Error", "Parameters object evaluated to an empty string.")
            Return
        End If
        
        ' 4. Safe array splitting and index checking
        Dim parts As String() = inputStr.Split("|"c)
        
        If parts IsNot Nothing AndAlso parts.Length >= 2 Then
            msgid = parts(0).Trim()
            msgtxt = parts(1).Trim()
        Else
            msgtxt = inputStr
        End If

        ' Final safety check to ensure we actually have text to send
        If String.IsNullOrEmpty(msgtxt) Then
            hs.WriteLog("Script Error", "Parsed message text is empty.")
            Return
        End If
        
        hs.WriteLog("Script Info", "Processing message: " & msgtxt)
        
        ' 5. URL Escape the message text to prevent HTTP breaks (spaces, special characters)
        Dim escapedMsgTxt As String = Uri.EscapeDataString(msgtxt)
        url = "http://192.168.1.160:3000/api/board/LCL836/messages/" & escapedMsgTxt
        
        ' 6. Secure HTTP Object creation
        xmlhttp = CreateObject("MSXML2.ServerXMLHTTP.6.0")
        If xmlhttp Is Nothing Then
            hs.WriteLog("Script Error", "Failed to create MSXML2.ServerXMLHTTP.6.0 object.")
            Return
        End If
        
        ' Open connection (Method, URL, Asynchronous=False)
        xmlhttp.open("DELETE", url, False)
        
        ' Set necessary headers
        xmlhttp.setRequestHeader("Content-Type", "application/json")
        
        ' 7. Send payload and wrap network transit in explicit check
        xmlhttp.send()
        
        ' 8. Evaluate HTTP Status Codes instead of assuming success
        Dim statusCode As Integer = Convert.ToInt32(xmlhttp.status)
        response = xmlhttp.responseText
        
        If statusCode >= 200 AndAlso statusCode < 300 Then
            hs.WriteLog("HTTP Success", "Successful update to the board. Status: " & statusCode)
        Else
            hs.WriteLog("HTTP Error", "Server returned failure code: " & statusCode & " | Response: " & response)
        End If
        
    Catch ex As Exception
        ' 9. Universal safety net to prevent HomeSeer/host crashes
        hs.WriteLog("Script Crash Exception", "Error: " & ex.Message & vbCrLf & ex.StackTrace)
    Finally
        ' 10. Guaranteed memory cleanup even if an error happens midway
        If xmlhttp IsNot Nothing Then
            xmlhttp = Nothing
        End If
    End Try
End Sub
