(function() {
	$("#features-collapse .ui-widget-content").show();

	$(".fdefault label.btn-radio").bind('click',function() {
		var radio = $(this).children("input[type=radio]");
		var feature = radio.attr('name').substring(4);

		var defcode = $("#defcode_" + feature).val();
		var customcode = $("#customcode_" + feature).val();

		if (radio.val() == 'def')
		{
			$("." + feature).attr('readonly','readonly');
			$("." + feature).val(defcode);
		}
		else
		{
			$("." + feature).removeAttr('readonly');
			$("." + feature).val(customcode);
		}

	});

	$(".fcode_name").bind("keyup",function() {
		var fcode_name = $(this).attr('data-name');
		var fvalue = $(this).val();

		$("#customcode_" + fcode_name).val(fvalue);
	});

})();
