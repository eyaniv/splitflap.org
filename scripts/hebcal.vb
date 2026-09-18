Imports System.Net
Imports System.Globalization
Imports Newtonsoft.Json.Linq

' ------------------------------------------------------------
' Hebcal day-status script for HomeSeer HS4 (VB.NET scripting engine)
'
' Compatible with the HS4 script host: synchronous only (no Async/Await),
' no System.Text.Json, no DateOnly. Uses WebClient + Newtonsoft.Json.Linq,
' both of which are proven to work in the HS4 script sandbox.
'
' If "Imports Newtonsoft.Json.Linq" fails to compile with 'JsonConvert'/
' 'JObject' not declared, add this to settings.ini under [Scripts] or the
' top-level section (adjust path to your actual HomeSeer bin folder):
'   ScriptingReferences=Newtonsoft.Json;bin\Newtonsoft.Json.dll
' ------------------------------------------------------------

' ---- Result type ----
Public Class DayStatus
    Public QueryDate As Date

    Public IsShabbat As Boolean
    Public ParashaName As String = ""

    Public IsYomTov As Boolean
    Public YomTovName As String = ""
    Public YomTovSubcat As String = ""  ' "major" or "minor" per Hebcal

    Public HasCandleLighting As Boolean
    Public CandleLighting As Date

    Public HasHavdalah As Boolean
    Public Havdalah As Date

    ' Second candle-lighting event, dated the evening of qDate itself rather
    ' than erev. Only appears when qDate is a Yom Tov/Shabbat day immediately
    ' followed by another Yom Tov day (e.g. Shabbat -> 2-day Rosh Hashana),
    ' where melacha continues into the next night via a transferred flame
    ' instead of a normal Havdalah.
    Public HasNextCandleLighting As Boolean
    Public NextCandleLighting As Date

    Public HebrewDate As String = ""

    Public ReadOnly Property IsRestDay As Boolean
        Get
            Return IsShabbat OrElse IsYomTov
        End Get
    End Property

    Public Overrides Function ToString() As String
        Dim parts As String = ""
        If IsShabbat Then parts &= "Shabbat (" & ParashaName & ") "
        If IsYomTov Then parts &= YomTovName & " "
        If parts = "" Then parts = "Weekday "

        Dim timing As String = ""
        If HasCandleLighting Then timing &= "candles " & CandleLighting.ToString("t") & " "
        If HasNextCandleLighting Then timing &= "candles(2) " & NextCandleLighting.ToString("t") & " "
        If HasHavdalah Then timing &= "havdalah " & Havdalah.ToString("t")

        Return QueryDate.ToString("yyyy-MM-dd") & ": " & parts.Trim() & _
               IIf(timing.Trim() <> "", " [" & timing.Trim() & "]", "")
    End Function
End Class

' ------------------------------------------------------------
' Entry point. Wire this up as your event script action.
' params(0) = optional date string "yyyy-MM-dd" (defaults to today) or shabbat for shabbat
'             or shabbat for the nearest shabbat, today or tomorrow
' params(1) = optional geonameid (defaults to Boise, ID = 5586437)
' params(2) = optional mapping (key>hsrefvalue,...)
' ------------------------------------------------------------
Sub Main(ByVal params As Object)
    Dim targetDate As Date = Now.Date
    Dim geonameId As Integer = 5591778 ' Eagle, ID
    Dim mapping = CreateObject("Scripting.Dictionary")

    Dim inputStr As String = ""

	Try
	    ' 1. Correctly extract parameter string from HomeSeer object array
		If TypeOf params Is Array Then
			Dim arr() As Object = CType(params, Object())
			If arr.Length > 0 AndAlso arr(0) IsNot Nothing Then
				inputStr = arr(0).ToString()
			End If
		Else ' we are being called outside of HS for some reason
			inputStr = params.ToString()
		End If

		' Debug checkpoint
		' hs.WriteLog("Script Debug", "Received raw input string: " & inputStr)
	
		' 2. Split multiple parameters separated by a pipe (|)
		Dim parts As String() = inputStr.Split("|"c)
		Dim dateparam, mappingparam
	
		If parts.Length >= 2 Then
			dateparam = parts(0)
			If IsNumeric(parts(1)) Then
				geonameId = CInt(parts(1))
			End If
			If parts.Length >= 3  Then
				mappingparam = parts(2)
			End If
		Else
			dateparam = inputStr
		End If

		If dateparam IsNot Nothing Then
			If StrComp(dateparam, "shabbat", 1) = 0 Then
				targetDate = GetNearestSaturday(Now.Date)
			Else If StrComp(dateparam, "today", 1) = 0 Then
				' Do nothin, itargetDate is already set to today
			Else If StrComp(dateparam, "tomorrow", 1) = 0 Then
				targetDate = DateAdd ("d", 1, targetDate)
			Else
				Dim dateString As String = If(dateparam IsNot Nothing, dateparam.ToString().Trim(), "")
				targetDate = Date.ParseExact(dateString, "yyyy-MM-dd", CultureInfo.InvariantCulture)
			End If
		 ' hs.WriteLog("Hebcal", "Target date is " & targetDate)
		 
		 If mappingparam IsNot Nothing Then
		 	Dim mapparts As String() = mappingparam.Split(","c)
		 	Dim mp
		 	For Each mp In mapparts
		 	    Dim mpp = mp.Split(">"c)
		 	    If mpp.Length = 2 Then
		 	    	mapping.Add(mpp(0), mpp(1))
		 			' hs.WriteLog("Script", mpp(0))
		 		End If
		 	Next
		 End If 
		Else
			hs.WriteLog("Script", "No parameters received. Using today's date param syntax: [date[|geoid[|mapping]]]")
		End If

    Catch ex As Exception
        ' fall back to defaults if parms weren't in the expected shape
		hs.WriteLog ("Hebcal", "Failed parsing unput parameters" & ex.Message)
    End Try

    Dim status As DayStatus = GetHebcalDayStatus(targetDate, geonameId)
    
    Try
    	Dim k
    	For Each k In mapping.Keys
    		' hs.WriteLog ("Script", "Inspecting " & k.ToString() )
    		Select Case k.ToString()
    			Case "cl"
    				If status.HasCandleLighting Then
    					' hs.WriteLog ("Script", "Writing Candle Lighting to ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), status.CandleLighting.ToString("t"), True)
    				Else
    					' hs.WriteLog ("Script", "Removing Candle Lighting from ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), "", True)    				
    				End If
    			Case "cl2"
    				If status.HasNextCandleLighting Then
    					' hs.WriteLog ("Script", "Writing 2nd Candle Lighting to ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), status.NextCandleLighting.ToString("t"), True)
    				Else
    					' hs.WriteLog ("Script", "Removing 2nd Candle Lighting from ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), "", True)    				
    				End If
    			Case "hv"
    				If status.HasHavdalah Then
    					' hs.WriteLog ("Script", "Writing Havdalah to ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), status.Havdalah.ToString("t"), True)
    				Else
    					' hs.WriteLog ("Script", "Removing Havdalah from ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), "", True)    				
    				End If
    			Case "pr"
    				If status.ParashaName <> "" Then
    					' hs.WriteLog ("Script", "Writing Parsha to ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), status.ParashaName, True)
    				Else
    					' hs.WriteLog ("Script", "Removing stale Parsha from ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), "", True)
    				End If
    			Case "hd"
    				If status.HebrewDate <> "" Then
    					' hs.WriteLog ("Script", "Writing Hebrew date to ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), status.HebrewDate, True)
    				End If
    			Case "yn"
    				If status.IsYomTov Then
    					' hs.WriteLog ("Script", "Writing Yom Tov name to ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), status.YomTovName, True)
    				Else
    					' hs.WriteLog ("Script", "Removing Yom tov name from ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), "", True)
    				End If
    			Case "ynb"
   					' hs.WriteLog ("Script", "Writing Yom Tov as boolean name to ref " & mapping.item(k))
    				If status.IsYomTov Then
    					hs.SetDeviceValueByRef(CInt(mapping.item(k)), 1, True)
    				Else
    					hs.SetDeviceValueByRef(CInt(mapping.item(k)), 0, True)
    				End If
    			Case "ymm"
    				If status.IsYomTov Then
    					' hs.WriteLog ("Script", "Writing Yom Tov major/minor to ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), status.YomTovSubcat, True)
    				Else
    					' hs.WriteLog ("Script", "Removing subcat from ref " & mapping.item(k))
    					hs.SetDeviceString(CInt(mapping.item(k)), "", True)    				
    				End If
    			Case "ymmb"
   					Dim majorminor as Integer = 0
   					' hs.WriteLog ("Script", "Writing Yom Tov major/minor as boolean to ref " & mapping.item(k))
    				If (status.IsYomTov) And (status.YomTovSubcat = "major") Then
   						majorminor = 1
   					End If
   					hs.SetDeviceValueByRef(CInt(mapping.item(k)), majorminor, True)
    		End Select
    	Next
    Catch ex As Exception
        ' couldn't find the item in the map
		hs.WriteLog ("Hebcal", "couldn't find the item in the map" & ex.Message)
    End Try

    ' hs.WriteLog("Hebcal", status.ToString())

    ' Example: push the result into a virtual device's string status so
    ' other events/automations can react to it. Replace DevRef with your
    ' actual virtual device reference number.
    ' Dim DevRef As Integer = hs.GetDeviceRefByName("Jewish Calendar Status")
    ' hs.SetDeviceString(DevRef, status.ToString(), True)
End Sub

' ------------------------------------------------------------
' Saturday lookup: given a date returns the nearest future shabbat
' ------------------------------------------------------------
Function GetNearestSaturday(inputDate)
    ' Weekday returns 1 for Sunday, 2 for Monday, ..., 7 for Saturday
    Dim wDay
    wDay = Weekday(inputDate)
    
    Dim offset
    Select Case wDay
        Case 1: offset = 6  ' Sunday -> shabbat is in 6 days
        Case 2: offset = 5  ' Monday
        Case 3: offset = 4  ' Tuesday
        Case 4: offset = 3   ' Wednesday
        Case 5: offset = 2   ' Thursday
        Case 6: offset = 1   ' Friday
        Case 7: offset = 0   ' Already Saturday
    End Select
    
    GetNearestSaturday = DateAdd("d", offset, inputDate)
End Function

' ------------------------------------------------------------
' Core lookup: given a date and a Hebcal geonameid, returns Shabbat/
' Yom Tov status plus candle-lighting/havdalah times for that date.
' ------------------------------------------------------------
Function GetHebcalDayStatus(qDate As Date, geonameId As Integer) As DayStatus
Try
    ' Pull a window from yesterday until the day after,
    ' so havdalah is always captured.
    Dim windowStart As String = qDate.AddDays(-1).ToString("yyyy-MM-dd")
    Dim windowEnd As String = qDate.AddDays(1).ToString("yyyy-MM-dd")

    ' hs.WriteLog("Script", windowStart & "  " & windowEnd)

    Dim url As String = "https://www.hebcal.com/hebcal?v=1&cfg=json" & _
        "&maj=on&min=on&mod=on&c=on&s=on&leyning=off" & _
        "&geonameid=" & geonameId.ToString() & _
        "&start=" & windowStart & "&end=" & windowEnd

    ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12

    Dim json As String
    Using client As New WebClient()
        client.Headers.Add("User-Agent", "HomeSeer-Hebcal-Script/1.0")
        json = client.DownloadString(url)
    End Using

    Dim root As JObject = JObject.Parse(json)
    Dim items As JArray = CType(root("items"), JArray)

    Dim status As New DayStatus()
    status.QueryDate = qDate

    ' --- Shabbat: any Saturday is Shabbat, regardless of whether a weekly
    ' parasha is read that week. On a Shabbat that coincides with a Yom Tov
    ' (e.g. Rosh Hashana), the holiday's own reading supersedes the parasha,
    ' so Hebcal emits no "parashat" item at all — that's expected, not a
    ' missing-data bug. ParashaName is left empty in that case. ---
    If qDate.DayOfWeek = DayOfWeek.Saturday Then
        status.IsShabbat = True
        For Each tok As JToken In items
            Dim item As JObject = CType(tok, JObject)
            If CategoryOf(item) = "parashat" AndAlso DateOf(item).Date = qDate.Date Then
                status.ParashaName = item("title").ToString()
                Dim prefixToRemove As String = "Parashat"
                If status.ParashaName.StartsWith(prefixToRemove, StringComparison.OrdinalIgnoreCase) Then
                    status.ParashaName = status.ParashaName.Substring(prefixToRemove.Length).TrimStart()
                End If
                status.HebrewDate = HdateOf(item)
                Exit For
            End If
        Next
    End If

    ' --- Yom Tov: a "holiday" event on this exact date with yomtov=true ---
    For Each tok As JToken In items
        Dim item As JObject = CType(tok, JObject)
        If CategoryOf(item) = "holiday" AndAlso IsYomTovEvent(item) AndAlso DateOf(item).Date = qDate.Date Then
            status.IsYomTov = True
            status.YomTovName = item("title").ToString()
            status.YomTovSubcat = SubcatOf(item)
            If status.HebrewDate = "" Then status.HebrewDate = HdateOf(item)
            Exit For
        End If
    Next

    ' --- Candle lighting / havdalah, only relevant if this is a rest day ---
    If status.IsShabbat OrElse status.IsYomTov Then
        Dim erev As Date = qDate.AddDays(-1)

        For Each tok As JToken In items
            Dim item As JObject = CType(tok, JObject)
            If CategoryOf(item) = "candles" AndAlso DateOf(item).Date = erev.Date Then
                status.HasCandleLighting = True
                status.CandleLighting = DateOf(item)
                Exit For
            End If
        Next

        For Each tok As JToken In items
            Dim item As JObject = CType(tok, JObject)
            If CategoryOf(item) = "havdalah" AndAlso DateOf(item).Date = qDate.Date Then
                status.HasHavdalah = True
                status.Havdalah = DateOf(item)
                Exit For
            End If
        Next

        ' Second candle-lighting event dated on qDate itself (evening),
        ' distinct from the erev-dated one above. Only present when the day
        ' flows into another Yom Tov day rather than exiting into a weekday
        ' (e.g. Shabbat -> 2-day Rosh Hashana), in which case Hebcal emits a
        ' "candles" event instead of "havdalah" for that transition.
        For Each tok As JToken In items
            Dim item As JObject = CType(tok, JObject)
            If CategoryOf(item) = "candles" AndAlso DateOf(item).Date = qDate.Date Then
                status.HasNextCandleLighting = True
                status.NextCandleLighting = DateOf(item)
                Exit For
            End If
        Next
    End If

    Return status
Catch ex As Exception
        hs.WriteLog("Script Error", ex.Message)
End Try
End Function

' ---- helpers ----

Function CategoryOf(item As JObject) As String
    Dim tok As JToken = item("category")
    If tok Is Nothing Then Return ""
    Return tok.ToString()
End Function

Function DateOf(item As JObject) As Date
    Return DateTime.Parse(item("date").ToString(), CultureInfo.InvariantCulture, DateTimeStyles.None)
End Function

Function HdateOf(item As JObject) As String
    Dim tok As JToken = item("hdate")
    If tok Is Nothing Then Return ""
    Return tok.ToString()
End Function

Function SubcatOf(item As JObject) As String
    Dim tok As JToken = item("subcat")
    If tok Is Nothing Then Return ""
    Return tok.ToString()
End Function

Function IsYomTovEvent(item As JObject) As Boolean
    Dim tok As JToken = item("yomtov")
    If tok Is Nothing Then Return False
    Return CBool(tok)
End Function
