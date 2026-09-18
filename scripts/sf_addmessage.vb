Imports System.Text.RegularExpressions

Sub Main(ByVal parms As Object)
    Dim xmlhttp As Object = Nothing
    Dim url As String = ""
    Dim payload As String = ""
    Dim response As String = ""
    Dim msgid As String = ""
    Dim msgtxt As String = ""
    Dim ttl As Integer = 0
    Dim priority as String = "normal"
    Dim inputStr As String = ""

    ' 1. FIX: Correctly extract parameter string from HomeSeer object array
    If parms Is Nothing Then
        hs.WriteLog("Script Error", "No parameters received. Use format: id|msg[|ttl-priority]")
        Return
    End If

    Try
        If TypeOf parms Is Array Then
            Dim arr() As Object = CType(parms, Object())
            If arr.Length > 0 AndAlso arr(0) IsNot Nothing Then
                inputStr = arr(0).ToString()
            End If
        Else
            inputStr = parms.ToString()
        End If
    Catch ex As Exception
        hs.WriteLog("Script Error", "Failed to parse input parameters: " & ex.Message)
        Return
    End Try

    ' Debug checkpoint
    'hs.WriteLog("Script Debug", "Received raw input string: " & inputStr)

    ' 2. Split multiple parameters separated by a pipe (|)
    Dim parts As String() = inputStr.Split("|"c)
    
    ' we have more than one parameter, in the form of id|text|ttl-priority
    ' ttl=priority can be either optional, so 120 or 120- or 120-high or -high are all legal
    If parts.Length >= 2 Then
        msgid = parts(0).Trim()
        msgtxt = parts(1)
        'If parts.Length >= 3 AndAlso IsNumeric(parts(2)) Then
        If parts.Length >= 3 Then
        	Dim ttlpri As String = parts(2).ToString()
        	hs.WriteLog("Script Debug", "In ttl-pri presplit " & ttlpri)
        	Dim ttlpriParts As String() = ttlpri.Split("-")
        	hs.WriteLog("Script Debug", "In ttl-pri section " & ttlpriParts.Length)
        	If ttlpriParts.Length > 0 Then
        	hs.WriteLog("Script Debug", "In ttl section " & ttlpriParts(0))
        		If (Not String.IsNullOrEmpty(ttlpriParts(0))) AndAlso IsNumeric(ttlpriParts(0)) Then
        			ttl = CInt(ttlpriParts(0))
        		End If ' at least one parameter - assign to TTL
        	End If
        	If ttlpriParts.Length > 1 Then
	        	hs.WriteLog("Script Debug", "In pri section " & ttlpriParts(1))
        		If Not String.IsNullOrEmpty(ttlpriParts(1)) Then
        			priority = ttlpriParts(1).ToString()
        		End If ' at least 2 parameters, assign to priority
        	End If
            
        End If ' had a 3rd parameter, in the form of ttl-priority. this was made so we can pass either as optional
    Else
        msgtxt = inputStr
    End If
    
    
    ' Patterns - replace $$D?R:(ref): with the homeseer device value/string/date/hebrew etc
    ' Patternx is a nested value - a string containing other patterns. parse it first, beore all splits
    Dim patternx As String = "\$\$DXR:\((?<ref>\d+)\):" ' extract device string, and parse nested values in a string
    Dim patternv As String = "\$\$DVR:\((?<ref>\d+)\):" ' extract device value
    Dim patterns As String = "\$\$DSR:\((?<ref>\d+)\):" ' extract device string
    Dim patternt As String = "\$\$DTR:\((?<ref>\d+)\):" ' extract device last change time
    Dim patternd As String = "\$\$DDR:\((?<ref>\d+)\):" ' extract device last change date-time
    Dim patternc As String = "\$\$DCR:\((?<ref>\d+)\):" ' extract device value, and convert to celsius
    Dim patternh As String = "\$\$DHR:\((?<ref>\d+)\):" ' extract device string and reverse Hebrew
    Dim patternw As String = "\$\$DWR:\((?<ref>\d+)\):" ' extract device string with word wrap

	' msgtxt contains the message to the board, but we need to expand all patterns, and create line brakes

	' Calculate patternx - a nested pattern string.
	Dim expandedmsgtxt As String = Regex.Replace(msgtxt, patternx, Function(m As Match)
		Dim refValue As Integer = Integer.Parse(m.Groups("ref").Value)
		Return hs.DeviceString(refValue)
	End Function)

	' each '&' becomes a new line
    Dim lines As String() = expandedmsgtxt.Split("&"c)

	' rebuild message into msgtxt again
    msgtxt = ""
    Dim firstline As Boolean = True

    ' 3. Process replacement loops with error handling per loop

    For Each ln As String In lines
        Try
            If Not firstline Then
                msgtxt = msgtxt & "\n"
            End If

            ' Calculate the replaced string with device values
            Dim result As String = Regex.Replace(ln, patternv, Function(m As Match)
                Dim refValue As Integer = Integer.Parse(m.Groups("ref").Value)
                Return CStr(hs.DeviceValue(refValue))
            End Function)

            ' Calculate the replaced string with device strings
            Dim result2 As String = Regex.Replace(result, patterns, Function(m As Match)
                Dim refValue As Integer = Integer.Parse(m.Groups("ref").Value)
                Dim devStr As String = hs.DeviceString(refValue)
                
                If String.IsNullOrEmpty(devStr) Then devStr = ""
                
                Dim cleanHTMLTags As String = Regex.Replace(devStr.Trim(), "<[^>]*>", "")
                Return Regex.Replace(cleanHTMLTags, "[^\w\s:.\-_]", "") ' Fixed unescaped hyphen in character class
            End Function)

            ' Calculate the replaced string with device last change time
            Dim result3 As String = Regex.Replace(result2, patternt, Function(m As Match)
                Dim refValue As Integer = Integer.Parse(m.Groups("ref").Value)
                Dim lastchangedate as Date = hs.DeviceLastChangeRef(refValue)
				Return lastchangedate.ToString("h:mm tt")
            End Function)

            ' Calculate the replaced string with device last change date and time
            Dim result4 As String = Regex.Replace(result3, patternd, Function(m As Match)
                Dim refValue As Integer = Integer.Parse(m.Groups("ref").Value)
                Dim lastchangedate as Date = hs.DeviceLastChangeRef(refValue)
				Return lastchangedate.ToString("MMM-d h:mm tt")
            End Function)

            ' Calculate the replaced string with device values, converted to celsius
            Dim result5 As String = Regex.Replace(result4, patternc, Function(m As Match)
                Dim refValue As Integer = Integer.Parse(m.Groups("ref").Value)
				Dim fahrenheit As Double = hs.DeviceValue(refValue)
				Dim celsius As Double = (fahrenheit - 32) * 5 / 9
                Return Math.Round(celsius, MidpointRounding.AwayFromZero)
            End Function)

            ' Calculate the replaced string with device strings, and flip Hebrew
            Dim result6 As String = Regex.Replace(result5, patternh, Function(m As Match)
                Dim refValue As Integer = Integer.Parse(m.Groups("ref").Value)
                Dim devStr As String = hs.DeviceString(refValue)
                If String.IsNullOrEmpty(devStr) Then devStr = ""
                Dim cleanHTMLTags As String = Regex.Replace(devStr.Trim(), "<[^>]*>", "")
                Return ReverseHebrewOnly(Regex.Replace(cleanHTMLTags, "[^\w\s:.\-_]", "")) ' Fixed unescaped hyphen in character class
            End Function)

            ' Calculate the replaced string with device strings, and flip Hebrew
            Dim result7 As String = Regex.Replace(result6, patternw, Function(m As Match)
                Dim refValue As Integer = Integer.Parse(m.Groups("ref").Value)
                Dim devStr As String = hs.DeviceString(refValue)
                If String.IsNullOrEmpty(devStr) Then devStr = ""
                Dim cleanHTMLTags As String = Regex.Replace(devStr.Trim(), "<[^>]*>", "")
                Return WordWrap(Regex.Replace(cleanHTMLTags, "[^\w\s:.\-_]", ""),22) ' Fixed unescaped hyphen in character class
            End Function)

            msgtxt = msgtxt & result7
            firstline = False
        Catch ex As Exception
            hs.WriteLog("Script Error", "Error processing string line [" & ln & "]: " & ex.Message)
        End Try
    Next
    
    ' 4. Build JSON (and basic escape quotes to prevent JSON breakage)
    msgtxt = msgtxt.Replace("""", "\""") 
    
    url = "http://192.168.1.160:3000/api/board/LCL836/messages"
    payload = "{""id"": """ & msgid & """, ""text"": """ & msgtxt & """"
    If ttl > 0 Then
        payload = payload & ", ""ttl"": " & ttl
    End If
    'If priority <> "normal" Then
        payload = payload & ", ""priority"": """ & priority & """"
    'End If
    payload = payload & "}"
    
    hs.WriteLog("Script Debug", "Sending JSON Payload: " & payload)
    
    ' 5. Safely execute HTTP POST
    Try
        xmlhttp = CreateObject("MSXML2.ServerXMLHTTP.6.0")
        xmlhttp.open("POST", url, False)
        xmlhttp.setRequestHeader("Content-Type", "application/json")
        xmlhttp.send(payload)
        
        response = xmlhttp.responseText
        ' hs.WriteLog("HTTP POST Success", "Server returned: " & response)
        hs.WriteLog("HTTP Success", "Successful update to the board")
    Catch ex As Exception
        hs.WriteLog("HTTP Error", "Network or server failure: " & ex.Message)
    Finally
        xmlhttp = Nothing
    End Try
End Sub

Function WordWrap(txt, maxChars)
    Dim words, currentLine, result, i, word
    
    ' Standardized line break format for clean output strings
    Dim nl = "\n"
    
    ' Clean spacing issues before starting
    txt = Trim(txt)
    If Len(txt) = 0 Then
        WordWrap = ""
        Exit Function
    End If
    
    ' Split into individual words using standard spaces
    words = Split(txt, " ")
    currentLine = ""
    result = ""
    
    For i = 0 To UBound(words)
        word = words(i)
        
        ' Handle edge case: A single word is longer than maxChars
        If Len(word) > maxChars Then
            ' Flush out whatever is currently in the active line buffer
            If Len(currentLine) > 0 Then
                result = result & currentLine & nl
                currentLine = ""
            End If
            
            ' Chop up the oversized word into pieces matching maxChars
            Do While Len(word) > maxChars
                result = result & Left(word, maxChars) & nl
                word = Mid(word, maxChars + 1)
            Loop
            currentLine = word ' Assign any remainder to start the next line
            
        ' Standard case: Adding word fits within maxChars limit
        ElseIf Len(currentLine) + 1 + Len(word) <= maxChars Then
            If Len(currentLine) > 0 Then
                currentLine = currentLine & " " & word
            Else
                currentLine = word
            End If
            
        ' Wrap case: Active line is full; push word to a fresh row
        Else
            result = result & currentLine & nl
            currentLine = word
        End If
    Next
    
    ' Append any trailing text left in the final buffer
    If Len(currentLine) > 0 Then
        result = result & currentLine
    End If
    
    WordWrap = result
End Function

Function ReverseHebrewOnly(txt)
    Dim i, c, currentHebrewBlock, result
    currentHebrewBlock = ""
    result = ""
    
    For i = 1 To Len(txt)
        c = Mid(txt, i, 1)
        
        ' 1. Check if the character itself is Hebrew
        If (AscW(c) >= &H0590 And AscW(c) <= &H05FF) Then
            currentHebrewBlock = currentHebrewBlock & c
            
        ' 2. If it's a space or punctuation, check if Hebrew follows later in the sentence
        ElseIf (c = " " Or c = "." Or c = "," Or c = "!" Or c = "?" Or c = "-" Or c = ":") And HasHebrewAhead(txt, i + 1) Then
            currentHebrewBlock = currentHebrewBlock & c
            
        ' 3. Encountered a non-Hebrew boundary (like English text)
        Else
            If Len(currentHebrewBlock) > 0 Then
                result = result & ReverseString(currentHebrewBlock)
                currentHebrewBlock = ""
            End If
            result = result & c
        End If
    Next
    
    ' Flush out any remaining Hebrew text at the very end of the string
    If Len(currentHebrewBlock) > 0 Then
        result = result & ReverseString(currentHebrewBlock)
    End If
    
    ReverseHebrewOnly = result
End Function

' Helper function to look ahead and see if Hebrew characters exist down the line
Function HasHebrewAhead(txt, startIdx)
    Dim j, cAhead
    HasHebrewAhead = False
    
    For j = startIdx To Len(txt)
        cAhead = Mid(txt, j, 1)
        ' If we hit a Hebrew character first, then the space/punctuation belongs to the sentence
        If (AscW(cAhead) >= &H0590 And AscW(cAhead) <= &H05FF) Then
            HasHebrewAhead = True
            Exit Function
        ' If we hit actual English letters/numbers before more Hebrew, stop looking
        ElseIf (AscW(cAhead) >= 65 And AscW(cAhead) <= 90) Or (AscW(cAhead) >= 97 And AscW(cAhead) <= 122) Or (AscW(cAhead) >= 48 And AscW(cAhead) <= 57) Then
            Exit Function
        End If
    Next
End Function

' Clean helper to reverse a string chunk without using deprecated keywords
Function ReverseString(str)
    Dim k, rev
    rev = ""
    For k = Len(str) To 1 Step -1
        rev = rev & Mid(str, k, 1)
    Next
    ReverseString = rev
End Function
